import type { FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CommandRunner } from "../lib/commandRunner.js";
import type { ProjectResolver } from "../lib/projectResolver.js";

export const LOCAL_DEPLOY_SCRIPT_PATH = "deploy/publish-local.sh";
export const LOCAL_DEPLOY_TIMEOUT_MS = 1000 * 60 * 60;

type LocalDeployRoutesContext = ProjectResolver & {
  runProjectCommand: CommandRunner;
};

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

    try {
      return await context.runProjectCommand(
        projectPath,
        "bash",
        [scriptPath],
        LOCAL_DEPLOY_TIMEOUT_MS,
        { displayCommand: "bash " + scriptPath, signal: controller.signal }
      );
    } finally {
      if (activeDeployments.get(projectPath) === controller) activeDeployments.delete(projectPath);
    }
  });
}
