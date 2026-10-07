import type { CommandResult } from "../../types/common";
import type { LocalDeployEvent, LocalDeployJobSnapshot } from "../../types/projects";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithTheme } from "../../test/render";
import { LocalDeployAction } from "./LocalDeployAction";

const fetchLocalDeployAvailability = vi.fn();
const fetchCurrentLocalDeployment = vi.fn();
const startLocalDeployment = vi.fn();
const watchLocalDeployment = vi.fn<(
  projectId: string,
  jobId: string,
  onEvent: (event: LocalDeployEvent) => void,
  signal?: AbortSignal
) => Promise<void>>();

vi.mock("../../api/projects", () => ({
  fetchLocalDeployAvailability: (projectId: string) => fetchLocalDeployAvailability(projectId),
  fetchCurrentLocalDeployment: (projectId: string) => fetchCurrentLocalDeployment(projectId),
  startLocalDeployment: (projectId: string) => startLocalDeployment(projectId),
  watchLocalDeployment: (
    projectId: string,
    jobId: string,
    onEvent: (event: LocalDeployEvent) => void,
    signal?: AbortSignal
  ) => watchLocalDeployment(projectId, jobId, onEvent, signal)
}));

const deploymentResult: CommandResult = {
  ok: true,
  command: "bash deploy/publish-local.sh",
  exitCode: 0,
  stdout: "deployment complete",
  stderr: "",
  output: "deployment complete",
  durationMs: 123
};

function runningJob(output: LocalDeployJobSnapshot["output"] = []): LocalDeployJobSnapshot {
  return {
    jobId: "job-1",
    scriptPath: "deploy/publish-local.sh",
    state: "running",
    startedAt: 1,
    completedAt: null,
    output,
    result: null
  };
}

function renderAction(onResult = vi.fn(), onCompleted = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  renderWithTheme(
    <QueryClientProvider client={client}>
      <LocalDeployAction
        projectId="alpha"
        projectName="Alpha"
        isActive
        onResult={onResult}
        onCompleted={onCompleted}
      />
    </QueryClientProvider>
  );
  return { onResult, onCompleted };
}

describe("LocalDeployAction", () => {
  let emitDeploymentEvent: (event: LocalDeployEvent) => void;
  let jobSnapshotForWatch: LocalDeployJobSnapshot;

  beforeEach(() => {
    fetchLocalDeployAvailability.mockReset();
    fetchCurrentLocalDeployment.mockReset();
    startLocalDeployment.mockReset();
    watchLocalDeployment.mockReset();
    fetchLocalDeployAvailability.mockResolvedValue({
      available: false,
      scriptPath: null
    });
    fetchCurrentLocalDeployment.mockResolvedValue(null);
    startLocalDeployment.mockResolvedValue(runningJob());
    jobSnapshotForWatch = runningJob();
    watchLocalDeployment.mockImplementation((_projectId, _jobId, onEvent) => new Promise<void>((resolve) => {
      emitDeploymentEvent = (event) => {
        onEvent(event);
        if (event.type === "complete") resolve();
      };
      onEvent({ type: "snapshot", job: jobSnapshotForWatch });
    }));
  });

  it("shows the action only when a local publish script exists", async () => {
    fetchLocalDeployAvailability.mockResolvedValue({
      available: true,
      scriptPath: "deploy/publish-local.sh"
    });

    renderAction();

    expect(await screen.findByRole("button", { name: "Deploy locally" })).toBeVisible();
    expect(fetchLocalDeployAvailability).toHaveBeenCalledWith("alpha");
  });

  it("asks before starting the local publish script and reports its result", async () => {
    const user = userEvent.setup();
    fetchLocalDeployAvailability.mockResolvedValue({
      available: true,
      scriptPath: "deploy/publish-local.sh"
    });
    const onResult = vi.fn();
    const onCompleted = vi.fn();
    renderAction(onResult, onCompleted);

    await user.click(await screen.findByRole("button", { name: "Deploy locally" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("deploy/publish-local.sh")).toBeVisible();
    expect(startLocalDeployment).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Deploy locally" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Start deployment" }));

    await waitFor(() => expect(watchLocalDeployment).toHaveBeenCalledWith(
      "alpha",
      "job-1",
      expect.any(Function),
      expect.any(AbortSignal)
    ));
    emitDeploymentEvent({ type: "complete", result: deploymentResult, completedAt: 2 });

    expect(startLocalDeployment).toHaveBeenCalledWith("alpha");
    expect(onResult).toHaveBeenCalledWith(deploymentResult);
    expect(onCompleted).toHaveBeenCalledOnce();
    expect(await screen.findByRole("log", { name: "Live deployment log" })).toBeVisible();
    expect(screen.getByText("Deployment completed successfully.")).toBeVisible();
  });

  it("restores an active deployment and its output after the page reloads", async () => {
    fetchLocalDeployAvailability.mockResolvedValue({
      available: true,
      scriptPath: "deploy/publish-local.sh"
    });
    fetchCurrentLocalDeployment.mockResolvedValue(runningJob([
      { stream: "stdout", chunk: "Building image 1/3…\n" }
    ]));
    jobSnapshotForWatch = runningJob([
      { stream: "stdout", chunk: "Building image 1/3…\n" }
    ]);

    renderAction();

    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(await screen.findByRole("log", { name: "Live deployment log" })).toHaveTextContent("Building image 1/3…");
    expect(screen.getByText("Deployment is running. New output appears below.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Resize deployment log" })).toBeVisible();
    await waitFor(() => expect(watchLocalDeployment).toHaveBeenCalledWith(
      "alpha",
      "job-1",
      expect.any(Function),
      expect.any(AbortSignal)
    ));
    expect(startLocalDeployment).not.toHaveBeenCalled();

    emitDeploymentEvent({ type: "output", stream: "stdout", chunk: "Building image 2/3…\n" });
    expect(await screen.findByRole("log", { name: "Live deployment log" })).toHaveTextContent("Building image 2/3…");
  });

  it("renders output while the deployment is still running", async () => {
    const user = userEvent.setup();
    fetchLocalDeployAvailability.mockResolvedValue({
      available: true,
      scriptPath: "deploy/publish-local.sh"
    });

    renderAction();
    await user.click(await screen.findByRole("button", { name: "Deploy locally" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Start deployment" }));

    await waitFor(() => expect(watchLocalDeployment).toHaveBeenCalled());
    emitDeploymentEvent({ type: "output", stream: "stdout", chunk: "Building image 1/3…\n" });
    expect(await screen.findByRole("log", { name: "Live deployment log" })).toHaveTextContent("Building image 1/3…");
    expect(screen.getByText("Deployment is running. New output appears below.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();

    const resizeHandle = screen.getByRole("button", { name: "Resize deployment log" });
    const dialog = screen.getByRole("dialog");
    fireEvent.pointerDown(resizeHandle, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 500 });
    expect(dialog).toHaveStyle({ width: "400px", height: "400px" });
    fireEvent.pointerUp(window);

    emitDeploymentEvent({ type: "complete", result: deploymentResult, completedAt: 2 });
    await waitFor(() => expect(screen.getByText("Deployment completed successfully.")).toBeVisible());
  });

  it("keeps local deployment hidden when the project has no configured script", async () => {
    renderAction();

    await waitFor(() => expect(fetchLocalDeployAvailability).toHaveBeenCalledWith("alpha"));
    expect(screen.queryByRole("button", { name: "Deploy locally" })).not.toBeInTheDocument();
  });
});
