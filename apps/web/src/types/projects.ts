import type { CommandResult } from "./common";

export type ProjectSummary = {
  id: string;
  name: string;
  path: string;
  branch: string;
  isClean: boolean;
  staged: number;
  modified: number;
  untracked: number;
  ahead: number;
  behind: number;
  upstream: string | null;
  lastCommit: {
    hash: string;
    message: string;
    date: string;
    author: string;
  } | null;
  hasDockerCompose: boolean;
};

export type LocalDeployAvailability = {
  available: boolean;
  scriptPath: string | null;
};

export type LocalDeployOutputStream = "stdout" | "stderr";
export type LocalDeployOutputHandler = (stream: LocalDeployOutputStream, chunk: string) => void;

export type LocalDeployLogChunk = {
  stream: LocalDeployOutputStream;
  chunk: string;
};

export type LocalDeployJobSnapshot = {
  jobId: string;
  scriptPath: string;
  state: "running" | "completed";
  startedAt: number;
  completedAt: number | null;
  output: LocalDeployLogChunk[];
  result: CommandResult | null;
};

export type LocalDeployEvent =
  | { type: "snapshot"; job: LocalDeployJobSnapshot }
  | ({ type: "output" } & LocalDeployLogChunk)
  | { type: "complete"; result: CommandResult; completedAt: number };

export type ProjectsResponse = {
  root: string;
  projects: ProjectSummary[];
};

export type ProjectDetailTab = "overview" | "git" | "branches" | "terminal" | "docker";
