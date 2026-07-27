// ui/panel.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  StandardTooltip,
  cn,
  usePluginTranslation
} from "@shofer/plugin-ui";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var MAX_VISIBLE_ROWS = 5;
var ROW_HEIGHT_PX = 28;
function FileChangesPanel({ api }) {
  const t = usePluginTranslation();
  const taskId = api.context.task?.taskId;
  const messageCount = api.context.task?.messageCount;
  const [payload, setPayload] = useState();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState();
  const errorTimer = useRef(null);
  const flash = useCallback((message) => {
    setError(message);
    if (errorTimer.current) window.clearTimeout(errorTimer.current);
    errorTimer.current = window.setTimeout(() => setError(void 0), 5e3);
  }, []);
  const refresh = useCallback(async () => {
    try {
      const result = await api.request("get");
      setPayload(result);
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err));
    }
  }, [api, flash]);
  useEffect(() => {
    setPayload(void 0);
    void refresh();
  }, [taskId, refresh]);
  const lastPullRef = useRef(0);
  useEffect(() => {
    if (messageCount === void 0) return;
    const since = Date.now() - lastPullRef.current;
    if (since < 1e3) return;
    lastPullRef.current = Date.now();
    void refresh();
  }, [messageCount, refresh]);
  useEffect(
    () => api.onMessage((message) => {
      const update = message;
      if (update?.type !== "changedFiles" || !update.payload) return;
      if (taskId && update.payload.taskId !== taskId) return;
      setPayload(update.payload);
    }),
    [api, taskId]
  );
  useEffect(
    () => () => {
      if (errorTimer.current) window.clearTimeout(errorTimer.current);
    },
    []
  );
  const act = useCallback(
    async (method, params) => {
      try {
        await api.request(method, params, { mutates: true });
      } catch (err) {
        flash(err instanceof Error ? err.message : String(err));
      }
      await refresh();
    },
    [api, flash, refresh]
  );
  const showDiff = useCallback(
    async (entry) => {
      if (!entry.hasOriginalContent) return;
      try {
        const diff = await api.request("diff", { path: entry.path });
        if (!diff) return;
        await api.request("local:show-diff", diff);
      } catch (err) {
        flash(err instanceof Error ? err.message : String(err));
      }
    },
    [api, flash]
  );
  const entries = payload?.entries ?? [];
  if (entries.length === 0 && !error) return null;
  const totals = entries.reduce(
    (acc, entry) => ({ added: acc.added + entry.insertions, removed: acc.removed + entry.deletions }),
    { added: 0, removed: 0 }
  );
  return /* @__PURE__ */ jsxs(Collapsible, { open: expanded, onOpenChange: setExpanded, className: "px-3", children: [
    /* @__PURE__ */ jsxs(CollapsibleTrigger, { className: "flex items-center gap-2 w-full py-2 rounded-md text-left text-vscode-foreground hover:bg-vscode-list-hoverBackground", children: [
      /* @__PURE__ */ jsx("span", { className: `codicon codicon-chevron-${expanded ? "down" : "right"}` }),
      /* @__PURE__ */ jsx("span", { className: "codicon codicon-diff-multiple" }),
      /* @__PURE__ */ jsx("span", { className: "text-sm font-medium", children: t("panel.header", { count: entries.length }) }),
      /* @__PURE__ */ jsxs("span", { className: "flex items-center gap-2 ml-auto shrink-0", children: [
        totals.added > 0 || totals.removed > 0 ? /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsxs("span", { className: "text-xs font-medium text-vscode-charts-green", children: [
            "+",
            totals.added
          ] }),
          /* @__PURE__ */ jsxs("span", { className: "text-xs font-medium text-vscode-charts-red", children: [
            "-",
            totals.removed
          ] })
        ] }) : null,
        /* @__PURE__ */ jsxs("span", { className: "flex gap-0.5", onClick: (event) => event.stopPropagation(), children: [
          /* @__PURE__ */ jsx(StandardTooltip, { content: t("panel.acceptAllTooltip"), children: /* @__PURE__ */ jsx(
            Button,
            {
              variant: "ghost",
              size: "icon",
              "aria-label": t("panel.acceptAll"),
              onClick: () => void act("accept-all"),
              children: /* @__PURE__ */ jsx("span", { className: "codicon codicon-check-all" })
            }
          ) }),
          /* @__PURE__ */ jsx(StandardTooltip, { content: t("panel.revertAllTooltip"), children: /* @__PURE__ */ jsx(
            Button,
            {
              variant: "ghost",
              size: "icon",
              "aria-label": t("panel.revertAll"),
              onClick: () => void act("revert-all"),
              children: /* @__PURE__ */ jsx("span", { className: "codicon codicon-discard" })
            }
          ) })
        ] })
      ] })
    ] }),
    error ? /* @__PURE__ */ jsx("div", { className: "text-sm text-vscode-errorForeground pb-1", children: error }) : null,
    /* @__PURE__ */ jsx(CollapsibleContent, { children: /* @__PURE__ */ jsx(
      "div",
      {
        className: "flex flex-col pb-2 pl-6 overflow-y-auto",
        style: { maxHeight: `${MAX_VISIBLE_ROWS * ROW_HEIGHT_PX}px` },
        children: entries.map((entry) => /* @__PURE__ */ jsxs(
          "div",
          {
            className: "flex items-center gap-2 py-1 text-sm rounded hover:bg-vscode-list-hoverBackground",
            children: [
              /* @__PURE__ */ jsx(
                StandardTooltip,
                {
                  content: entry.hasOriginalContent ? entry.path : t("panel.diffUnavailable"),
                  children: /* @__PURE__ */ jsx(
                    "button",
                    {
                      type: "button",
                      className: cn(
                        "flex-1 text-left truncate bg-transparent border-none p-0",
                        entry.hasOriginalContent ? "cursor-pointer hover:underline text-vscode-foreground" : "cursor-default text-vscode-descriptionForeground"
                      ),
                      onClick: () => void showDiff(entry),
                      children: entry.path
                    }
                  )
                }
              ),
              entry.binary ? /* @__PURE__ */ jsx("span", { className: "text-xs text-vscode-descriptionForeground shrink-0", children: t("panel.binary") }) : /* @__PURE__ */ jsxs("span", { className: "text-xs shrink-0 flex items-center gap-1", children: [
                /* @__PURE__ */ jsxs("span", { className: "text-vscode-charts-green", children: [
                  "+",
                  entry.insertions
                ] }),
                /* @__PURE__ */ jsxs("span", { className: "text-vscode-charts-red", children: [
                  "-",
                  entry.deletions
                ] })
              ] }),
              /* @__PURE__ */ jsxs("span", { className: "flex gap-0.5 shrink-0", children: [
                /* @__PURE__ */ jsx(StandardTooltip, { content: t("panel.revertTooltip"), children: /* @__PURE__ */ jsx(
                  Button,
                  {
                    variant: "ghost",
                    size: "icon",
                    "aria-label": t("panel.revert"),
                    onClick: () => void act("revert", { path: entry.path }),
                    children: /* @__PURE__ */ jsx("span", { className: "codicon codicon-discard" })
                  }
                ) }),
                /* @__PURE__ */ jsx(StandardTooltip, { content: t("panel.acceptTooltip"), children: /* @__PURE__ */ jsx(
                  Button,
                  {
                    variant: "ghost",
                    size: "icon",
                    "aria-label": t("panel.accept"),
                    onClick: () => void act("accept", { path: entry.path }),
                    children: /* @__PURE__ */ jsx("span", { className: "codicon codicon-check" })
                  }
                ) })
              ] })
            ]
          },
          entry.path
        ))
      }
    ) })
  ] });
}
export {
  FileChangesPanel as default
};
