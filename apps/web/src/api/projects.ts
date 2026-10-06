import type { CommandResult } from "../types/common";
import type { GitActivity, GitDetails, GitFileDiff } from "../types/git";
import type {
  LocalDeployAvailability,
  LocalDeployEvent,
  LocalDeployJobSnapshot,
  ProjectSummary,
  ProjectsResponse
} from "../types/projects";
import { ApiError, isRecord, jsonRequest, requestJson } from "./http";

export function fetchProjects(signal?: AbortSignal): Promise<ProjectsResponse> {
  return requestJson(
    "/api/projects",
    "Unable to load projects",
    signal ? { signal } : undefined
  );
}

export function fetchProjectSummary(projectId: string): Promise<ProjectSummary> {
  return requestJson(`/api/projects/${projectId}/summary`, "Unable to refresh project");
}

export async function runProjectAction(
  projectId: string,
  actionPath: string,
  label: string,
  body?: unknown
): Promise<CommandResult> {
  const init = body === undefined
    ? { method: "POST" as const }
    : jsonRequest("POST", body);
  const payload = await requestJson<unknown>(
    `/api/projects/${projectId}/${actionPath}`,
    "Action failed",
    init
  );

  if (isRecord(payload) && "command" in payload) {
    return payload as CommandResult;
  }

  return {
    ok: true,
    command: label,
    exitCode: 0,
    stdout: "",
    stderr: "",
    output: "Requested",
    durationMs: 0
  };
}

export function fetchLocalDeployAvailability(projectId: string): Promise<LocalDeployAvailability> {
  return requestJson("/api/projects/" + projectId + "/local-deploy", "Unable to check local deployment");
}

export function fetchCurrentLocalDeployment(projectId: string): Promise<LocalDeployJobSnapshot | null> {
  return requestJson(
    "/api/projects/" + projectId + "/local-deploy/current",
    "Unable to check the running deployment"
  );
}

export function startLocalDeployment(projectId: string): Promise<LocalDeployJobSnapshot> {
  return requestJson(
    "/api/projects/" + projectId + "/local-deploy",
    "Local deployment failed",
    { method: "POST" }
  );
}

export async function watchLocalDeployment(
  projectId: string,
  jobId: string,
  onEvent: (event: LocalDeployEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(
    "/api/projects/" + projectId + "/local-deploy/" + encodeURIComponent(jobId) + "/events",
    { signal }
  );
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const message = isRecord(payload) && typeof payload.message === "string"
      ? payload.message
      : "Unable to connect to the deployment log";
    const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : null;
    throw new ApiError(message, response.status, code, payload);
  }

  if (!response.body) {
    throw new Error("The deployment log stream is unavailable.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  function consumeLine(line: string): void {
    if (!line.trim()) return;

    const event: unknown = JSON.parse(line);
    if (isLocalDeployEvent(event)) onEvent(event);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });

      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex !== -1) {
        consumeLine(pending.slice(0, newlineIndex));
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }

      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }

  if (pending.trim()) consumeLine(pending);
}

function isLocalDeployEvent(value: unknown): value is LocalDeployEvent {
  if (!isRecord(value)) return false;
  if (value.type === "snapshot") return isRecord(value.job);
  if (value.type === "output") {
    return (value.stream === "stdout" || value.stream === "stderr") && typeof value.chunk === "string";
  }
  return value.type === "complete" && isRecord(value.result) && typeof value.completedAt === "number";
}

export function fetchGitDetails(projectId: string): Promise<GitDetails> {
  return requestJson(`/api/projects/${projectId}/git/details`, "Unable to load Git details");
}

export function fetchGitActivity(
  projectId: string,
  options: { offset: number; limit: number }
): Promise<GitActivity> {
  const searchParams = new URLSearchParams({
    offset: String(options.offset),
    limit: String(options.limit)
  });

  return requestJson(
    `/api/projects/${projectId}/git/activity?${searchParams.toString()}`,
    "Unable to load Git activity"
  );
}

export function fetchGitFileDiff(
  projectId: string,
  file: { path: string; previousPath: string | null },
  staged: boolean
): Promise<GitFileDiff> {
  const searchParams = new URLSearchParams({
    path: file.path,
    staged: String(staged)
  });
  if (file.previousPath) searchParams.set("previousPath", file.previousPath);

  return requestJson(
    `/api/projects/${projectId}/git/diff?${searchParams.toString()}`,
    "Unable to load file diff"
  );
}

export function runTerminalCommand(projectId: string, command: string): Promise<CommandResult> {
  return requestJson(
    `/api/projects/${projectId}/terminal/run`,
    "Command failed",
    jsonRequest("POST", { command })
  );
}

export function cancelTerminalCommand(projectId: string): Promise<{ ok: true; cancelled: true }> {
  return requestJson(
    `/api/projects/${projectId}/terminal/cancel`,
    "Unable to cancel command",
    { method: "POST" }
  );
}

export function fetchTerminalSuggestions(projectId: string, input: string): Promise<{ suggestions: string[] }> {
  const search = new URLSearchParams({ input });
  return requestJson(
    `/api/projects/${projectId}/terminal/suggestions?${search.toString()}`,
    "Unable to load terminal suggestions"
  );
}
