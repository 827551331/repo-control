import assert from "node:assert/strict";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import type { CommandResult } from "../lib/commandRunner.js";
import {
  LOCAL_DEPLOY_SCRIPT_PATH,
  LOCAL_DEPLOY_TIMEOUT_MS,
  registerLocalDeployRoutes
} from "./localDeployRoutes.js";

function commandResult(command = "bash deploy/publish-local.sh"): CommandResult {
  return {
    ok: true,
    command,
    exitCode: 0,
    stdout: "deployment complete",
    stderr: "",
    output: "deployment complete",
    durationMs: 123
  };
}

async function createProject(t: TestContext): Promise<{ app: FastifyInstance; projectPath: string }> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "repo-control-local-deploy-"));
  const app = Fastify();

  t.after(async () => {
    await app.close();
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  return { app, projectPath };
}

function registerRoutes(
  app: FastifyInstance,
  projectPath: string,
  runProjectCommand: Parameters<typeof registerLocalDeployRoutes>[1]["runProjectCommand"]
): Promise<void> {
  return registerLocalDeployRoutes(app, {
    getActiveRootPath: () => projectPath,
    setActiveRootPath: () => undefined,
    resolveProjectPath: async () => projectPath,
    runProjectCommand
  });
}

test("advertises and runs the fixed local publish script from the repository root", async (t) => {
  const { app, projectPath } = await createProject(t);
  await fs.mkdir(path.join(projectPath, "deploy"));
  await fs.writeFile(path.join(projectPath, LOCAL_DEPLOY_SCRIPT_PATH), "echo deployment complete\n");

  const calls: Array<{ cwd: string; command: string; args: string[]; timeout: number | undefined }> = [];
  const streamedOutput: string[] = [];
  await registerRoutes(app, projectPath, async (cwd, command, args, timeout, options) => {
    calls.push({ cwd, command, args, timeout });
    options?.onOutput?.("stdout", "building image\n");
    options?.onOutput?.("stderr", "warning\n");
    streamedOutput.push("received callback output");
    return commandResult();
  });

  const availability = await app.inject({ method: "GET", url: "/api/projects/alpha/local-deploy" });
  assert.equal(availability.statusCode, 200);
  assert.deepEqual(availability.json(), {
    available: true,
    scriptPath: LOCAL_DEPLOY_SCRIPT_PATH
  });

  const response = await app.inject({ method: "POST", url: "/api/projects/alpha/local-deploy" });
  assert.equal(response.statusCode, 200);
  const contentType = response.headers["content-type"];
  assert.ok(typeof contentType === "string" && /application\/x-ndjson/.test(contentType));
  const events = response.body.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events, [
    { type: "output", stream: "stdout", chunk: "building image\n" },
    { type: "output", stream: "stderr", chunk: "warning\n" },
    { type: "complete", result: commandResult() }
  ]);
  assert.equal(streamedOutput.length, 1);
  assert.deepEqual(calls, [{
    cwd: projectPath,
    command: "bash",
    args: [LOCAL_DEPLOY_SCRIPT_PATH],
    timeout: LOCAL_DEPLOY_TIMEOUT_MS
  }]);
});

test("hides and refuses deployment when the repository has no local publish script", async (t) => {
  const { app, projectPath } = await createProject(t);
  let runCount = 0;
  await registerRoutes(app, projectPath, async () => {
    runCount += 1;
    return commandResult();
  });

  const availability = await app.inject({ method: "GET", url: "/api/projects/alpha/local-deploy" });
  assert.equal(availability.statusCode, 200);
  assert.deepEqual(availability.json(), { available: false, scriptPath: null });

  const response = await app.inject({ method: "POST", url: "/api/projects/alpha/local-deploy" });
  assert.equal(response.statusCode, 404);
  assert.equal(runCount, 0);
});

test("does not advertise a script that resolves outside the repository", {
  skip: process.platform === "win32" ? "Symlink behavior is covered on Unix" : false
}, async (t) => {
  const { app, projectPath } = await createProject(t);
  const outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), "repo-control-local-deploy-outside-"));
  t.after(async () => fs.rm(outsidePath, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectPath, "deploy"));
  await fs.writeFile(path.join(outsidePath, "publish-local.sh"), "echo outside\n");
  await fs.symlink(path.join(outsidePath, "publish-local.sh"), path.join(projectPath, LOCAL_DEPLOY_SCRIPT_PATH));
  let runCount = 0;
  await registerRoutes(app, projectPath, async () => {
    runCount += 1;
    return commandResult();
  });

  const availability = await app.inject({ method: "GET", url: "/api/projects/alpha/local-deploy" });
  assert.deepEqual(availability.json(), { available: false, scriptPath: null });
  const response = await app.inject({ method: "POST", url: "/api/projects/alpha/local-deploy" });
  assert.equal(response.statusCode, 404);
  assert.equal(runCount, 0);
});

test("rejects a second deployment while one is already running", async (t) => {
  const { app, projectPath } = await createProject(t);
  await fs.mkdir(path.join(projectPath, "deploy"));
  await fs.writeFile(path.join(projectPath, LOCAL_DEPLOY_SCRIPT_PATH), "echo deployment complete\n");

  let completeFirst: ((result: CommandResult) => void) | undefined;
  let started = false;
  await registerRoutes(app, projectPath, async () => {
    started = true;
    return new Promise<CommandResult>((resolve) => {
      completeFirst = resolve;
    });
  });

  const firstRun = app.inject({ method: "POST", url: "/api/projects/alpha/local-deploy" });
  while (!started) await new Promise((resolve) => setImmediate(resolve));

  const secondResponse = await app.inject({ method: "POST", url: "/api/projects/alpha/local-deploy" });
  assert.equal(secondResponse.statusCode, 409);

  completeFirst?.(commandResult());
  assert.equal((await firstRun).statusCode, 200);
});
