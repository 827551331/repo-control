import RocketLaunchOutlinedIcon from "@mui/icons-material/RocketLaunchOutlined";
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { useTranslation } from "react-i18next";
import { fetchLocalDeployAvailability, runLocalDeployment } from "../../api/projects";
import type { CommandResult } from "../../types/common";
import { commandErrorResult } from "../../utils/commandResult";

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
  const availabilityQuery = useQuery({
    queryKey: ["project-local-deploy", projectId],
    queryFn: () => fetchLocalDeployAvailability(projectId),
    enabled: isActive,
    staleTime: 30_000
  });
  const availability = availabilityQuery.data;

  async function startDeployment() {
    setIsConfirmOpen(false);
    setIsRunning(true);

    try {
      onResult(await runLocalDeployment(projectId));
    } catch (error) {
      onResult(commandErrorResult(t("project.detail.localDeploy"), error));
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
        onClick={() => setIsConfirmOpen(true)}
      >
        {isRunning ? t("project.detail.localDeployRunning") : t("project.detail.localDeploy")}
      </Button>
      <Dialog
        open={isConfirmOpen}
        onClose={() => setIsConfirmOpen(false)}
        maxWidth="xs"
        fullWidth
        aria-labelledby="local-deploy-confirm-title"
      >
        <DialogTitle id="local-deploy-confirm-title">
          {t("project.detail.localDeployConfirmTitle", { name: projectName })}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>{t("project.detail.localDeployConfirmBody")}</DialogContentText>
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
        </DialogActions>
      </Dialog>
    </>
  );
}
