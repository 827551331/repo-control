import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CommandOutputStream, CommandResult, CommandRunner } from "../lib/commandRunner.js";
import type { ProjectResolver } from "../lib/projectResolver.js";

export const LOCAL_DEPLOY_SCRIPT_PATH = "deploy/publish-local.sh";
export const LOCAL_DEPLOY_TIMEOUT_MS = 1000 * 60 * 60;
const LOCAL_DEPLOY_LOG_LIMIT = 30_000;

type LocalDeployRoutesContext = ProjectResolver & {
  runProjectCommand: CommandRunner;
};

type LocalDeployLogChunk = { stream: CommandOutputStream; chunk: string };
type LocalDeployEvent =
  | { type: "snapshot"; job: LocalDeployJobSnapshot }
  | ({ type: "output" } & LocalDeployLogChunk)
  | { type: "complete"; result: CommandResult; completedAt: number };

type LocalDeployJobSnapshot = {
  jobId: string;
  scriptPath: string;
  state: "running" | "completed";
  startedAt: number;
  completedAt: number | null;
  output: LocalDeployLogChunk[];
  result: CommandResult | null;
};

type LocalDeployJob = LocalDeployJobSnapshot & {
  outputLength: number;
  listeners: Set<(event: LocalDeployEvent) => void>;
};

const projectParamsSchema = z.object({ id: z.string() });
const projectJobParamsSchema = z.object({ id: z.string(), jobId: z.string() });

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
  const deploymentsByProjectPath = new Map<string, LocalDeployJob>();
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

  app.get("/api/projects/:id/local-deploy/current", async (request) => {
    const params = projectParamsSchema.parse(request.params);
    const projectPath = await context.resolveProjectPath(params.id);
    const job = deploymentsByProjectPath.get(projectPath);

    return job?.state === "running" ? snapshotJob(job) : null;
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

    const job: LocalDeployJob = {
      jobId: randomUUID(),
      scriptPath,
      state: "running",
      startedAt: Date.now(),
      completedAt: null,
      output: [],
      outputLength: 0,
      result: null,
      listeners: new Set()
    };
    const controller = new AbortController();
    deploymentsByProjectPath.set(projectPath, job);
    activeDeployments.set(projectPath, controller);

    void runDeployment(context.runProjectCommand, projectPath, job, controller, () => {
      if (activeDeployments.get(projectPath) === controller) activeDeployments.delete(projectPath);
    });

    return reply.code(202).send(snapshotJob(job));
  });

  app.get("/api/projects/:id/local-deploy/:jobId/events", async (request, reply) => {
    const params = projectJobParamsSchema.parse(request.params);
    const projectPath = await context.resolveProjectPath(params.id);
    const job = deploymentsByProjectPath.get(projectPath);

    if (!job || job.jobId !== params.jobId) {
      return reply.code(404).send({ ok: false, message: "The local deployment is no longer available." });
    }

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
    const onEvent = (event: LocalDeployEvent): void => {
      sendEvent(event);
      if (event.type === "complete") {
        unsubscribe();
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      }
    };
    const unsubscribe = (): void => {
      job.listeners.delete(onEvent);
      reply.raw.off("close", unsubscribe);
    };

    job.listeners.add(onEvent);
    reply.raw.on("close", unsubscribe);
    sendEvent({ type: "snapshot", job: snapshotJob(job) });
    if (job.state === "completed" && !reply.raw.destroyed && !reply.raw.writableEnded) {
      unsubscribe();
      reply.raw.end();
    }
  });
}

async function runDeployment(
  runProjectCommand: CommandRunner,
  projectPath: string,
  job: LocalDeployJob,
  controller: AbortController,
  onSettled: () => void
): Promise<void> {
  const command = "bash " + job.scriptPath;

  try {
    const result = await runProjectCommand(
      projectPath,
      "bash",
      [job.scriptPath],
      LOCAL_DEPLOY_TIMEOUT_MS,
      {
        displayCommand: command,
        signal: controller.signal,
        onOutput: (stream, chunk) => appendJobOutput(job, stream, chunk)
      }
    );
    completeJob(job, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    completeJob(job, {
      ok: false,
      command,
      exitCode: null,
      stdout: "",
      stderr: message,
      output: message,
      durationMs: Date.now() - job.startedAt
    });
  } finally {
    onSettled();
  }
}

function appendJobOutput(job: LocalDeployJob, stream: CommandOutputStream, chunk: string): void {
  if (!chunk) return;

  const entry = { stream, chunk };
  job.output.push(entry);
  job.outputLength += chunk.length;
  while (job.outputLength > LOCAL_DEPLOY_LOG_LIMIT && job.output.length > 0) {
    const first = job.output[0];
    if (!first) break;
    const excess = job.outputLength - LOCAL_DEPLOY_LOG_LIMIT;
    if (first.chunk.length <= excess) {
      job.output.shift();
      job.outputLength -= first.chunk.length;
    } else {
      job.output[0] = { ...first, chunk: first.chunk.slice(excess) };
      job.outputLength = LOCAL_DEPLOY_LOG_LIMIT;
    }
  }

  emitJobEvent(job, { type: "output", ...entry });
}

function completeJob(job: LocalDeployJob, result: CommandResult): void {
  job.state = "completed";
  job.completedAt = Date.now();
  job.result = result;
  emitJobEvent(job, { type: "complete", result, completedAt: job.completedAt });
}

function emitJobEvent(job: LocalDeployJob, event: LocalDeployEvent): void {
  for (const listener of job.listeners) listener(event);
}

function snapshotJob(job: LocalDeployJob): LocalDeployJobSnapshot {
  return {
    jobId: job.jobId,
    scriptPath: job.scriptPath,
    state: job.state,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    output: job.output.map((entry) => ({ ...entry })),
    result: job.result
  };
}
