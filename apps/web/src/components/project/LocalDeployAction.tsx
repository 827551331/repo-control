import RocketLaunchOutlinedIcon from "@mui/icons-material/RocketLaunchOutlined";
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Typography
} from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React from "react";
import { useTranslation } from "react-i18next";
import {
  fetchCurrentLocalDeployment,
  fetchLocalDeployAvailability,
  startLocalDeployment,
  watchLocalDeployment
} from "../../api/projects";
import type { CommandResult } from "../../types/common";
import type { LocalDeployEvent, LocalDeployJobSnapshot, LocalDeployOutputStream } from "../../types/projects";
import { commandErrorResult } from "../../utils/commandResult";

type LiveOutputChunk = { stream: LocalDeployOutputStream; text: string };
const LIVE_OUTPUT_MAX_LENGTH = 30_000;
const MIN_DIALOG_WIDTH = 360;
const MIN_DIALOG_HEIGHT = 300;

type LocalDeployActionProps = {
  projectId: string;
  projectName: string;
  isActive: boolean;
  onResult: (result: CommandResult) => void;
  onCompleted: () => void;
};

export function LocalDeployAction({
  projectId,
  projectName,
  isActive,
  onResult,
  onCompleted
}: LocalDeployActionProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isConfirmOpen, setIsConfirmOpen] = React.useState(false);
  const [isRunning, setIsRunning] = React.useState(false);
  const [hasStarted, setHasStarted] = React.useState(false);
  const [liveOutput, setLiveOutput] = React.useState<LiveOutputChunk[]>([]);
  const [deploymentResult, setDeploymentResult] = React.useState<CommandResult | null>(null);
  const [logConnectionLost, setLogConnectionLost] = React.useState(false);
  const [dialogSize, setDialogSize] = React.useState<{ width: number; height: number } | null>(null);
  const outputRef = React.useRef<HTMLPreElement | null>(null);
  const resizeStartRef = React.useRef<{ pointerX: number; pointerY: number; width: number; height: number } | null>(null);
  const watchedJobIdRef = React.useRef<string | null>(null);
  const watcherAbortRef = React.useRef<AbortController | null>(null);
  const onResultRef = React.useRef(onResult);
  const onCompletedRef = React.useRef(onCompleted);
  onResultRef.current = onResult;
  onCompletedRef.current = onCompleted;
  const availabilityQuery = useQuery({
    queryKey: ["project-local-deploy", projectId],
    queryFn: () => fetchLocalDeployAvailability(projectId),
    enabled: isActive,
    staleTime: 30_000
  });
  const currentDeploymentQuery = useQuery({
    queryKey: ["project-local-deploy-current", projectId],
    queryFn: () => fetchCurrentLocalDeployment(projectId),
    enabled: isActive,
    staleTime: 0,
    retry: false
  });
  const availability = availabilityQuery.data;
  const refetchAvailability = availabilityQuery.refetch;

  React.useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      const start = resizeStartRef.current;
      if (!start) return;

      const maxWidth = Math.max(MIN_DIALOG_WIDTH, window.innerWidth - 24);
      const maxHeight = Math.max(MIN_DIALOG_HEIGHT, window.innerHeight - 24);
      setDialogSize({
        width: Math.min(maxWidth, Math.max(MIN_DIALOG_WIDTH, start.width + event.clientX - start.pointerX)),
        height: Math.min(maxHeight, Math.max(MIN_DIALOG_HEIGHT, start.height + event.clientY - start.pointerY))
      });
    };
    const stopResizing = (): void => {
      resizeStartRef.current = null;
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResizing);
    window.addEventListener("pointercancel", stopResizing);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResizing);
      window.removeEventListener("pointercancel", stopResizing);
    };
  }, []);

  React.useEffect(() => {
    const outputElement = outputRef.current;
    if (outputElement) outputElement.scrollTop = outputElement.scrollHeight;
  }, [liveOutput]);

  const appendOutput = React.useCallback((stream: LocalDeployOutputStream, chunk: string): void => {
    setLiveOutput((current) => {
      const next = [...current, { stream, text: chunk }];
      let totalLength = next.reduce((total, entry) => total + entry.text.length, 0);

      while (totalLength > LIVE_OUTPUT_MAX_LENGTH && next.length > 1) {
        totalLength -= next.shift()?.text.length ?? 0;
      }

      if (totalLength > LIVE_OUTPUT_MAX_LENGTH && next[0]) {
        next[0] = { ...next[0], text: next[0].text.slice(-LIVE_OUTPUT_MAX_LENGTH) };
      }

      return next;
    });
  }, []);

  const finishDeployment = React.useCallback((result: CommandResult): void => {
    setIsRunning(false);
    setDeploymentResult(result);
    setLogConnectionLost(false);
    onResultRef.current(result);
    onCompletedRef.current();
    queryClient.setQueryData<LocalDeployJobSnapshot | null>(["project-local-deploy-current", projectId], null);
    void refetchAvailability();
  }, [projectId, queryClient, refetchAvailability]);

  const handleDeploymentEvent = React.useCallback((event: LocalDeployEvent): void => {
    if (event.type === "snapshot") {
      setHasStarted(true);
      setIsConfirmOpen(true);
      setLiveOutput(event.job.output.map((entry) => ({ stream: entry.stream, text: entry.chunk })));
      setLogConnectionLost(false);
      if (event.job.state === "running") {
        setIsRunning(true);
      } else if (event.job.result) {
        finishDeployment(event.job.result);
      }
      return;
    }

    if (event.type === "output") {
      setLogConnectionLost(false);
      appendOutput(event.stream, event.chunk);
      return;
    }

    finishDeployment(event.result);
  }, [appendOutput, finishDeployment]);

  React.useEffect(() => {
    const job = currentDeploymentQuery.data;
    if (!isActive || !job || job.state !== "running" || watchedJobIdRef.current === job.jobId) return;

    const controller = new AbortController();
    watchedJobIdRef.current = job.jobId;
    watcherAbortRef.current = controller;
    setHasStarted(true);
    setIsConfirmOpen(true);
    setIsRunning(true);
    setLiveOutput(job.output.map((entry) => ({ stream: entry.stream, text: entry.chunk })));
    setDeploymentResult(null);
    setLogConnectionLost(false);

    void watchLocalDeployment(projectId, job.jobId, handleDeploymentEvent, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setLogConnectionLost(true);
      appendOutput("stderr", `\n${error instanceof Error ? error.message : String(error)}\n`);
    });

    return () => {
      controller.abort();
      if (watcherAbortRef.current === controller) watcherAbortRef.current = null;
      if (watchedJobIdRef.current === job.jobId) watchedJobIdRef.current = null;
    };
  }, [appendOutput, currentDeploymentQuery.data, handleDeploymentEvent, isActive, projectId]);

  async function startDeployment() {
    setHasStarted(true);
    setLiveOutput([]);
    setDeploymentResult(null);
    setLogConnectionLost(false);
    setIsRunning(true);

    try {
      const job = await startLocalDeployment(projectId);
      queryClient.setQueryData<LocalDeployJobSnapshot | null>(["project-local-deploy-current", projectId], job);
    } catch (error) {
      finishDeployment(commandErrorResult(t("project.detail.localDeploy"), error));
    }
  }

  if (!availability?.available || !availability.scriptPath) {
    return null;
  }

  return (
    <>
      <Button
        size="small"
        variant="contained"
        color="primary"
        startIcon={isRunning ? <CircularProgress size={16} color="inherit" /> : <RocketLaunchOutlinedIcon />}
        disabled={isRunning || currentDeploymentQuery.isPending}
        onClick={() => {
          setHasStarted(false);
          setLiveOutput([]);
          setDeploymentResult(null);
          setIsConfirmOpen(true);
        }}
      >
        {isRunning ? t("project.detail.localDeployRunning") : t("project.detail.localDeploy")}
      </Button>
      <Dialog
        open={isConfirmOpen}
        onClose={() => {
          if (!isRunning) setIsConfirmOpen(false);
        }}
        maxWidth={false}
        aria-labelledby="local-deploy-title"
        PaperProps={{
          sx: {
            position: "relative",
            display: "flex",
            flexDirection: "column",
            width: hasStarted
              ? dialogSize?.width ?? "min(1280px, calc(100vw - 24px))"
              : "min(480px, calc(100vw - 32px))",
            height: hasStarted ? dialogSize?.height ?? "min(900px, calc(100vh - 24px))" : "auto",
            maxWidth: hasStarted ? "calc(100vw - 24px)" : "calc(100vw - 32px)",
            maxHeight: hasStarted ? "calc(100vh - 24px)" : "calc(100vh - 32px)",
            m: 1.5,
            overflow: "hidden",
            "@media (max-width: 600px)": {
              width: hasStarted ? dialogSize?.width ?? "calc(100vw - 16px)" : "calc(100vw - 32px)",
              height: hasStarted ? dialogSize?.height ?? "calc(100dvh - 16px)" : "auto",
              maxWidth: hasStarted ? "calc(100vw - 16px)" : "calc(100vw - 32px)",
              maxHeight: hasStarted ? "calc(100dvh - 16px)" : "calc(100dvh - 32px)",
              m: 1
            }
          }
        }}
      >
        <DialogTitle id="local-deploy-title">
          {hasStarted
            ? t("project.detail.localDeployLogTitle", { name: projectName })
            : t("project.detail.localDeployConfirmTitle", { name: projectName })}
        </DialogTitle>
        <DialogContent sx={{ display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
          {!hasStarted ? (
            <DialogContentText>{t("project.detail.localDeployConfirmBody")}</DialogContentText>
          ) : (
            <Stack spacing={1} sx={{ mb: 1.5, flex: 1, minHeight: 0 }}>
              <Typography variant="body2" color={
                isRunning ? "text.secondary" : deploymentResult?.ok ? "success.main" : "error.main"
              }>
                {isRunning
                  ? logConnectionLost
                    ? t("project.detail.localDeployLogDisconnected")
                    : t("project.detail.localDeployLogRunning")
                  : deploymentResult?.ok
                    ? t("project.detail.localDeployLogSucceeded")
                    : t("project.detail.localDeployLogFailed")}
              </Typography>
              <Box
                component="pre"
                role="log"
                aria-label={t("project.detail.localDeployLogLabel")}
                aria-live="polite"
                ref={outputRef}
                sx={{
                  m: 0,
                  flex: 1,
                  minHeight: 180,
                  overflow: "auto",
                  p: 1.5,
                  border: "1px solid",
                  borderColor: "divider",
                  borderRadius: 1,
                  bgcolor: "background.default",
                  fontFamily: "var(--rc-font-mono)",
                  fontSize: 12,
                  lineHeight: 1.55,
                  whiteSpace: "pre"
                }}
              >
                {liveOutput.length > 0
                  ? liveOutput.map((entry, index) => (
                    <Box
                      component="span"
                      key={`${index}-${entry.stream}`}
                      sx={{ color: entry.stream === "stderr" ? "warning.main" : "text.primary" }}
                    >
                      {entry.text}
                    </Box>
                  ))
                  : isRunning
                    ? t("project.detail.localDeployLogWaitingOutput")
                    : t("project.detail.localDeployLogNoOutput")}
              </Box>
            </Stack>
          )}
          <Box
            component="code"
            sx={{
              display: "block",
              mt: 1.25,
              px: 1.1,
              py: 0.85,
              borderRadius: 1,
              bgcolor: "action.hover",
              color: "text.primary",
              fontFamily: "var(--rc-font-mono)",
              fontSize: 13,
              overflowWrap: "anywhere"
            }}
          >
            {availability.scriptPath}
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 2.5, pb: 2, pr: hasStarted ? 6 : 2.5 }}>
          {!hasStarted ? (
            <>
              <Button onClick={() => setIsConfirmOpen(false)}>
                {t("project.detail.localDeployCancel")}
              </Button>
              <Button
                variant="contained"
                startIcon={<RocketLaunchOutlinedIcon />}
                onClick={() => void startDeployment()}
              >
                {t("project.detail.localDeployStart")}
              </Button>
            </>
          ) : (
            <Button onClick={() => setIsConfirmOpen(false)} disabled={isRunning}>
              {t("project.detail.localDeployClose")}
            </Button>
          )}
        </DialogActions>
        {hasStarted && (
          <Box
            component="button"
            type="button"
            aria-label={t("project.detail.localDeployResize")}
            title={t("project.detail.localDeployResize")}
            onPointerDown={(event: React.PointerEvent<HTMLButtonElement>) => {
              const paper = event.currentTarget.closest<HTMLElement>("[role='dialog']");
              if (!paper) return;
              const bounds = paper.getBoundingClientRect();
              resizeStartRef.current = {
                pointerX: event.clientX,
                pointerY: event.clientY,
                width: bounds.width,
                height: bounds.height
              };
              event.preventDefault();
            }}
            sx={{
              position: "absolute",
              right: 4,
              bottom: 4,
              zIndex: 1,
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              p: 0,
              border: 0,
              borderRadius: 1,
              bgcolor: "transparent",
              color: "text.secondary",
              cursor: "nwse-resize",
              touchAction: "none",
              "&::after": {
                content: "''",
                width: 12,
                height: 12,
                background: "repeating-linear-gradient(135deg, currentColor 0 1px, transparent 1px 4px)"
              },
              "&:hover": { bgcolor: "action.hover" },
              "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" }
            }}
          />
        )}
      </Dialog>
    </>
  );
}
