import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithTheme } from "../../test/render";
import { LocalDeployAction } from "./LocalDeployAction";

const fetchLocalDeployAvailability = vi.fn();
const runLocalDeployment = vi.fn();

vi.mock("../../api/projects", () => ({
  fetchLocalDeployAvailability: (...args: unknown[]) => fetchLocalDeployAvailability(...args),
  runLocalDeployment: (...args: unknown[]) => runLocalDeployment(...args)
}));

const deploymentResult = {
  ok: true,
  command: "bash deploy/publish-local.sh",
  exitCode: 0,
  stdout: "deployment complete",
  stderr: "",
  output: "deployment complete",
  durationMs: 123
};

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
  beforeEach(() => {
    fetchLocalDeployAvailability.mockReset();
    runLocalDeployment.mockReset();
    fetchLocalDeployAvailability.mockResolvedValue({
      available: false,
      scriptPath: null
    });
    runLocalDeployment.mockResolvedValue(deploymentResult);
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

  it("asks before running the local publish script and reports its result", async () => {
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
    expect(runLocalDeployment).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Deploy locally" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Start deployment" }));

    await waitFor(() => expect(runLocalDeployment).toHaveBeenCalledWith("alpha", expect.any(Function)));
    expect(onResult).toHaveBeenCalledWith(deploymentResult);
    expect(onCompleted).toHaveBeenCalledOnce();
    expect(screen.getByRole("log", { name: "Live deployment log" })).toBeVisible();
    expect(screen.getByText("Deployment completed successfully.")).toBeVisible();
  });

  it("renders output while the deployment promise is still running", async () => {
    const user = userEvent.setup();
    fetchLocalDeployAvailability.mockResolvedValue({
      available: true,
      scriptPath: "deploy/publish-local.sh"
    });
    let reportOutput: ((stream: "stdout" | "stderr", chunk: string) => void) | undefined;
    let completeDeployment: ((result: typeof deploymentResult) => void) | undefined;
    runLocalDeployment.mockImplementation((_projectId, onOutput) => {
      reportOutput = onOutput as typeof reportOutput;
      return new Promise((resolve) => {
        completeDeployment = resolve;
      });
    });

    renderAction();
    await user.click(await screen.findByRole("button", { name: "Deploy locally" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Start deployment" }));

    await waitFor(() => expect(reportOutput).toBeDefined());
    reportOutput?.("stdout", "Building image 1/3…\n");
    expect(await screen.findByRole("log", { name: "Live deployment log" })).toHaveTextContent("Building image 1/3…");
    expect(screen.getByText("Deployment is running. New output appears below.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();

    completeDeployment?.(deploymentResult);
    await waitFor(() => expect(screen.getByText("Deployment completed successfully.")).toBeVisible());
  });

  it("keeps local deployment hidden when the project has no configured script", async () => {
    renderAction();

    await waitFor(() => expect(fetchLocalDeployAvailability).toHaveBeenCalledWith("alpha"));
    expect(screen.queryByRole("button", { name: "Deploy locally" })).not.toBeInTheDocument();
  });
});
