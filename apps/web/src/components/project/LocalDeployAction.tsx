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
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { useTranslation } from "react-i18next";
import { fetchLocalDeployAvailability, runLocalDeployment } from "../../api/projects";
import type { CommandResult } from "../../types/common";
import type { LocalDeployOutputStream } from "../../types/projects";
import { commandErrorResult } from "../../utils/commandResult";

type LiveOutputChunk = { stream: LocalDeployOutputStream; text: string };
const LIVE_OUTPUT_MAX_LENGTH = 30_000;

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
  const [isConfirmOpen, setIsConfirmOpen] = React.useState(false);
  const [isRunning, setIsRunning] = React.useState(false);
  const [hasStarted, setHasStarted] = React.useState(false);
  const [liveOutput, setLiveOutput] = React.useState<LiveOutputChunk[]>([]);
  const [deploymentResult, setDeploymentResult] = React.useState<CommandResult | null>(null);
  const outputRef = React.useRef<HTMLPreElement | null>(null);
  const availabilityQuery = useQuery({
    queryKey: ["project-local-deploy", projectId],
    queryFn: () => fetchLocalDeployAvailability(projectId),
    enabled: isActive,
    staleTime: 30_000
  });
  const availability = availabilityQuery.data;

  React.useEffect(() => {
    const outputElement = outputRef.current;
    if (outputElement) outputElement.scrollTop = outputElement.scrollHeight;
  }, [liveOutput]);

  function appendOutput(stream: LocalDeployOutputStream, chunk: string): void {
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
  }

  async function startDeployment() {
    setHasStarted(true);
    setLiveOutput([]);
    setDeploymentResult(null);
    setIsRunning(true);

    try {
      const result = await runLocalDeployment(projectId, appendOutput);
      setDeploymentResult(result);
      onResult(result);
    } catch (error) {
      const result = commandErrorResult(t("project.detail.localDeploy"), error);
      setDeploymentResult(result);
      onResult(result);
    } finally {
      setIsRunning(false);
      onCompleted();
      void availabilityQuery.refetch();
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
        disabled={isRunning}
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
        maxWidth="xs"
        fullWidth
        aria-labelledby="local-deploy-title"
      >
        <DialogTitle id="local-deploy-title">
          {hasStarted
            ? t("project.detail.localDeployLogTitle", { name: projectName })
            : t("project.detail.localDeployConfirmTitle", { name: projectName })}
        </DialogTitle>
        <DialogContent>
          {!hasStarted ? (
            <DialogContentText>{t("project.detail.localDeployConfirmBody")}</DialogContentText>
          ) : (
            <Stack spacing={1} sx={{ mb: 1.5 }}>
              <Typography variant="body2" color={
                isRunning ? "text.secondary" : deploymentResult?.ok ? "success.main" : "error.main"
              }>
                {isRunning
                  ? t("project.detail.localDeployLogRunning")
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
                  minHeight: 180,
                  maxHeight: 320,
                  overflow: "auto",
                  p: 1.5,
                  border: "1px solid",
                  borderColor: "divider",
                  borderRadius: 1,
                  bgcolor: "background.default",
                  fontFamily: "var(--rc-font-mono)",
                  fontSize: 12,
                  lineHeight: 1.55,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere"
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
        <DialogActions sx={{ px: 2.5, pb: 2 }}>
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
      </Dialog>
    </>
  );
}
