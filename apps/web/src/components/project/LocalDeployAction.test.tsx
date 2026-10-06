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

    await waitFor(() => expect(runLocalDeployment).toHaveBeenCalledWith("alpha"));
    expect(onResult).toHaveBeenCalledWith(deploymentResult);
    expect(onCompleted).toHaveBeenCalledOnce();
  });

  it("keeps local deployment hidden when the project has no configured script", async () => {
    renderAction();

    await waitFor(() => expect(fetchLocalDeployAvailability).toHaveBeenCalledWith("alpha"));
    expect(screen.queryByRole("button", { name: "Deploy locally" })).not.toBeInTheDocument();
  });
});
