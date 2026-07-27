// ui/settings.tsx
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, ToggleSwitch, cn, usePluginTranslation } from "@shofer/plugin-ui";
import { jsx, jsxs } from "react/jsx-runtime";
var POLL_MS = 2e3;
var TONE = {
  Indexed: "text-vscode-charts-green",
  Indexing: "text-vscode-charts-blue",
  Error: "text-vscode-errorForeground",
  Standby: "text-vscode-descriptionForeground",
  Disabled: "text-vscode-descriptionForeground"
};
function ask(api, method, params, mutates = false) {
  return api.request(`local:${method}`, params, { mutates });
}
function Progress({ status }) {
  const t = usePluginTranslation();
  if (status.systemStatus !== "Indexing" || !status.totalItems) return null;
  const percent = Math.min(100, Math.round((status.processedItems ?? 0) / status.totalItems * 100));
  return /* @__PURE__ */ jsx("div", { className: "text-xs text-vscode-descriptionForeground", children: t("panel.progress", {
    processed: status.processedItems ?? 0,
    total: status.totalItems,
    unit: status.currentItemUnit ?? "items",
    percent
  }) });
}
function RagIndexingSettings({ api }) {
  const t = usePluginTranslation();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const refresh = useCallback(() => {
    void ask(api, "status").then((next) => {
      setStatus(next);
      setError(null);
    }).catch(
      (refreshError) => setError(refreshError instanceof Error ? refreshError.message : String(refreshError))
    );
  }, [api]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  const act = useCallback(
    async (method, params) => {
      setBusy(true);
      setError(null);
      try {
        await ask(api, method, params, true);
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : String(actionError));
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [api, refresh]
  );
  const code = status?.code;
  const git = status?.git;
  return /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-3 px-5 py-3", children: [
    /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsx("h4", { className: "text-sm font-semibold m-0", children: t("panel.title") }),
      /* @__PURE__ */ jsx("p", { className: "text-xs text-vscode-descriptionForeground m-0 mt-1", children: t("panel.description") })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
      /* @__PURE__ */ jsx("span", { className: "text-sm", children: t("panel.codeIndex") }),
      /* @__PURE__ */ jsx(Badge, { variant: "secondary", className: cn("text-[0.7em]", TONE[code?.systemStatus ?? "Standby"]), children: code?.systemStatus ?? t("panel.unknown") }),
      code?.message && /* @__PURE__ */ jsx("span", { className: "text-xs text-vscode-descriptionForeground", children: code.message })
    ] }),
    code && /* @__PURE__ */ jsx(Progress, { status: code }),
    /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap gap-2", children: [
      /* @__PURE__ */ jsx(
        Button,
        {
          variant: "secondary",
          size: "sm",
          disabled: busy || code?.systemStatus === "Indexing",
          onClick: () => void act("start-indexing"),
          children: t("panel.startIndexing")
        }
      ),
      /* @__PURE__ */ jsx(
        Button,
        {
          variant: "secondary",
          size: "sm",
          disabled: busy || code?.systemStatus !== "Indexing",
          onClick: () => void act("stop-indexing"),
          children: t("panel.stopIndexing")
        }
      ),
      /* @__PURE__ */ jsx(Button, { variant: "destructive", size: "sm", disabled: busy, onClick: () => void act("clear-index"), children: t("panel.clearIndex") })
    ] }),
    /* @__PURE__ */ jsxs("label", { className: "flex items-center gap-2 text-sm", children: [
      /* @__PURE__ */ jsx(
        ToggleSwitch,
        {
          checked: code?.workspaceEnabled !== false,
          size: "small",
          "aria-label": t("panel.workspaceEnabled"),
          onChange: (enabled) => void act("set-workspace-enabled", { enabled })
        }
      ),
      /* @__PURE__ */ jsx("span", { children: t("panel.workspaceEnabled") })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2 border-t border-vscode-panel-border pt-3", children: [
      /* @__PURE__ */ jsx("span", { className: "text-sm", children: t("panel.gitIndex") }),
      /* @__PURE__ */ jsx(Badge, { variant: "secondary", className: cn("text-[0.7em]", TONE[git?.systemStatus ?? "Standby"]), children: git?.systemStatus ?? t("panel.unknown") }),
      git?.message && /* @__PURE__ */ jsx("span", { className: "text-xs text-vscode-descriptionForeground", children: git.message })
    ] }),
    git && /* @__PURE__ */ jsx(Progress, { status: git }),
    /* @__PURE__ */ jsx("p", { className: "text-xs text-vscode-descriptionForeground m-0", children: t("panel.configureHint") }),
    error && /* @__PURE__ */ jsx("div", { className: "text-xs text-vscode-errorForeground", children: error })
  ] });
}
export {
  RagIndexingSettings as default
};
