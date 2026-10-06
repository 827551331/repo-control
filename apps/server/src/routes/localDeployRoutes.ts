import type { FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CommandOutputStream, CommandResult, CommandRunner } from "../lib/commandRunner.js";
import type { ProjectResolver } from "../lib/projectResolver.js";

export const LOCAL_DEPLOY_SCRIPT_PATH = "deploy/publish-local.sh";
export const LOCAL_DEPLOY_TIMEOUT_MS = 1000 * 60 * 60;

type LocalDeployRoutesContext = ProjectResolver & {
  runProjectCommand: CommandRunner;
};

type LocalDeployEvent =
  | { type: "output"; stream: CommandOutputStream; chunk: string }
  | { type: "complete"; result: CommandResult };

const projectParamsSchema = z.object({ id: z.string() });

export async function findLocalDeployScript(projectPath: string): Promise<string | null> {
  let projectRoot: string;
  let resolvedScriptPath: string;

  try {
    projectRoot = await fs.realpath(projectPath);
    resolvedScriptPath = await fs.realpath(path.join(projectRoot, LOCAL_DEPLOY_SCRIPT_PATH));
  } catch {
    return null;
  }

  const relativePath = path.relative(projectRoot, resolvedScriptPath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(".." + path.sep) || path.isAbsolute(relativePath)) {
    return null;
  }

  const scriptStat = await fs.stat(resolvedScriptPath).catch(() => null);
  return scriptStat?.isFile() ? LOCAL_DEPLOY_SCRIPT_PATH : null;
}

export async function registerLocalDeployRoutes(
  app: FastifyInstance,
  context: LocalDeployRoutesContext
): Promise<void> {
  const activeDeployments = new Map<string, AbortController>();

  app.addHook("onClose", async () => {
    for (const controller of activeDeployments.values()) controller.abort();
    activeDeployments.clear();
  });

  app.get("/api/projects/:id/local-deploy", async (request) => {
    const params = projectParamsSchema.parse(request.params);
    const projectPath = await context.resolveProjectPath(params.id);
    const scriptPath = await findLocalDeployScript(projectPath);

    return { available: scriptPath !== null, scriptPath };
  });

  app.post("/api/projects/:id/local-deploy", async (request, reply) => {
    const params = projectParamsSchema.parse(request.params);
    const projectPath = await context.resolveProjectPath(params.id);
    const scriptPath = await findLocalDeployScript(projectPath);

    if (!scriptPath) {
      return reply.code(404).send({
        ok: false,
        message: "This repository does not contain deploy/publish-local.sh."
      });
    }

    if (activeDeployments.has(projectPath)) {
      return reply.code(409).send({
        ok: false,
        message: "A local deployment is already running for this repository."
      });
    }

    const controller = new AbortController();
    activeDeployments.set(projectPath, controller);
    const command = "bash " + scriptPath;

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no"
    });
    reply.raw.flushHeaders();

    const sendEvent = (event: LocalDeployEvent): void => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(JSON.stringify(event) + "\n");
    };
    const abortOnDisconnect = (): void => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.on("close", abortOnDisconnect);

    try {
      const result = await context.runProjectCommand(
        projectPath,
        "bash",
        [scriptPath],
        LOCAL_DEPLOY_TIMEOUT_MS,
        {
          displayCommand: command,
          signal: controller.signal,
          onOutput: (stream, chunk) => sendEvent({ type: "output", stream, chunk })
        }
      );
      sendEvent({ type: "complete", result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result: CommandResult = {
        ok: false,
        command,
        exitCode: null,
        stdout: "",
        stderr: message,
        output: message,
        durationMs: 0
      };
      sendEvent({ type: "complete", result });
    } finally {
      if (activeDeployments.get(projectPath) === controller) activeDeployments.delete(projectPath);
      reply.raw.off("close", abortOnDisconnect);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
  });
}
