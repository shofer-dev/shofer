// ui/panel.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var MAX_VISIBLE_ROWS = 5;
var ROW_HEIGHT_PX = 28;
var ROW = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "2px 0",
  fontSize: "0.95em",
  borderRadius: 3
};
function iconButton() {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 20,
    height: 20,
    padding: 0,
    border: "none",
    borderRadius: 3,
    cursor: "pointer",
    background: "transparent",
    color: "var(--vscode-foreground)"
  };
}
function FileChangesPanel({ api }) {
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
  return /* @__PURE__ */ jsxs("div", { style: { padding: "0 12px" }, children: [
    /* @__PURE__ */ jsxs(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 0",
          cursor: "pointer",
          color: "var(--vscode-foreground)"
        },
        onClick: () => setExpanded((open) => !open),
        children: [
          /* @__PURE__ */ jsx("span", { className: `codicon codicon-chevron-${expanded ? "down" : "right"}` }),
          /* @__PURE__ */ jsx("span", { className: "codicon codicon-diff-multiple" }),
          /* @__PURE__ */ jsxs("span", { style: { fontWeight: 600 }, children: [
            entries.length,
            " file",
            entries.length === 1 ? "" : "s",
            " changed"
          ] }),
          /* @__PURE__ */ jsxs("span", { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }, children: [
            totals.added > 0 || totals.removed > 0 ? /* @__PURE__ */ jsxs(Fragment, { children: [
              /* @__PURE__ */ jsxs("span", { style: { color: "var(--vscode-charts-green)", fontSize: "0.9em" }, children: [
                "+",
                totals.added
              ] }),
              /* @__PURE__ */ jsxs("span", { style: { color: "var(--vscode-charts-red)", fontSize: "0.9em" }, children: [
                "-",
                totals.removed
              ] })
            ] }) : null,
            /* @__PURE__ */ jsxs("span", { style: { display: "flex", gap: 2 }, onClick: (event) => event.stopPropagation(), children: [
              /* @__PURE__ */ jsx(
                "button",
                {
                  style: iconButton(),
                  title: "Accept all changes (keep them, stop tracking)",
                  "aria-label": "Accept all",
                  onClick: () => void act("accept-all"),
                  children: /* @__PURE__ */ jsx("span", { className: "codicon codicon-check-all" })
                }
              ),
              /* @__PURE__ */ jsx(
                "button",
                {
                  style: iconButton(),
                  title: "Revert all changes",
                  "aria-label": "Revert all",
                  onClick: () => void act("revert-all"),
                  children: /* @__PURE__ */ jsx("span", { className: "codicon codicon-discard" })
                }
              )
            ] })
          ] })
        ]
      }
    ),
    error ? /* @__PURE__ */ jsx("div", { style: { color: "var(--vscode-errorForeground)", fontSize: "0.9em", paddingBottom: 4 }, children: error }) : null,
    expanded ? /* @__PURE__ */ jsx(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          paddingLeft: 18,
          paddingBottom: 6,
          maxHeight: MAX_VISIBLE_ROWS * ROW_HEIGHT_PX,
          overflowY: "auto"
        },
        children: entries.map((entry) => /* @__PURE__ */ jsxs("div", { style: ROW, children: [
          /* @__PURE__ */ jsx(
            "button",
            {
              style: {
                flex: 1,
                textAlign: "left",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: entry.hasOriginalContent ? "pointer" : "default",
                color: entry.hasOriginalContent ? "var(--vscode-foreground)" : "var(--vscode-descriptionForeground)"
              },
              title: entry.hasOriginalContent ? entry.path : `${entry.path} \u2014 no baseline was captured, so there is nothing to diff against`,
              onClick: () => void showDiff(entry),
              children: entry.path
            }
          ),
          entry.binary ? /* @__PURE__ */ jsx("span", { style: { color: "var(--vscode-descriptionForeground)", fontSize: "0.9em" }, children: "(binary)" }) : /* @__PURE__ */ jsxs("span", { style: { display: "flex", gap: 4, fontSize: "0.9em" }, children: [
            /* @__PURE__ */ jsxs("span", { style: { color: "var(--vscode-charts-green)" }, children: [
              "+",
              entry.insertions
            ] }),
            /* @__PURE__ */ jsxs("span", { style: { color: "var(--vscode-charts-red)" }, children: [
              "-",
              entry.deletions
            ] })
          ] }),
          /* @__PURE__ */ jsxs("span", { style: { display: "flex", gap: 2 }, children: [
            /* @__PURE__ */ jsx(
              "button",
              {
                style: iconButton(),
                title: "Revert this file",
                "aria-label": "Revert",
                onClick: () => void act("revert", { path: entry.path }),
                children: /* @__PURE__ */ jsx("span", { className: "codicon codicon-discard" })
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                style: iconButton(),
                title: "Accept this file (keep it, stop tracking)",
                "aria-label": "Accept",
                onClick: () => void act("accept", { path: entry.path }),
                children: /* @__PURE__ */ jsx("span", { className: "codicon codicon-check" })
              }
            )
          ] })
        ] }, entry.path))
      }
    ) : null
  ] });
}
export {
  FileChangesPanel as default
};
