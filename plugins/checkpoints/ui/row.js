// ui/row.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var NOTICE_TEXT = {
  "no-first": "No initial checkpoint found for this task.",
  "no-previous": "No earlier checkpoint to compare against.",
  "no-changes": "No changes between these checkpoints."
};
var ACCENT = "rgba(0, 188, 255, .65)";
function iconButton(active) {
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
    background: active ? "var(--vscode-toolbar-hoverBackground)" : "transparent",
    color: "var(--vscode-foreground)"
  };
}
var POPOVER = {
  position: "absolute",
  right: 0,
  top: 24,
  zIndex: 10,
  minWidth: 240,
  padding: 8,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  borderRadius: 4,
  background: "var(--vscode-editorWidget-background)",
  border: "1px solid var(--vscode-editorWidget-border, var(--vscode-widget-border))",
  boxShadow: "0 2px 8px rgba(0,0,0,.3)",
  fontSize: "0.9em"
};
function button(variant) {
  return {
    padding: "4px 8px",
    borderRadius: 2,
    border: "none",
    cursor: "pointer",
    textAlign: "center",
    background: variant === "primary" ? "var(--vscode-button-background)" : "var(--vscode-button-secondaryBackground)",
    color: variant === "primary" ? "var(--vscode-button-foreground)" : "var(--vscode-button-secondaryForeground)"
  };
}
var MUTED = { color: "var(--vscode-descriptionForeground)" };
function CheckpointRow({ api }) {
  const marker = api.context.message;
  const [hovering, setHovering] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState();
  const statusTimer = useRef(null);
  useEffect(
    () => () => {
      if (statusTimer.current) window.clearTimeout(statusTimer.current);
    },
    []
  );
  const flash = useCallback((text) => {
    setStatus(text);
    if (statusTimer.current) window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatus(void 0), 4e3);
  }, []);
  const showDiff = useCallback(
    async (mode) => {
      if (!marker?.text) return;
      setMoreOpen(false);
      try {
        const result = await api.request("diff", { commitHash: marker.text, mode });
        if (result?.notice) {
          flash(NOTICE_TEXT[result.notice] ?? "Nothing to show.");
          return;
        }
        await api.request("local:show-diff", { title: result.title, changes: result.changes });
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error));
      }
    },
    [api, marker?.text, flash]
  );
  const restore = useCallback(
    async (mode) => {
      if (!marker?.text) return;
      setRestoreOpen(false);
      setConfirming(false);
      try {
        await api.request("restore", { ts: marker.ts, commitHash: marker.text, mode }, { mutates: true });
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error));
      }
    },
    [api, marker?.ts, marker?.text, flash]
  );
  if (!marker?.text) return null;
  const menuVisible = hovering || restoreOpen || moreOpen;
  return /* @__PURE__ */ jsxs(
    "div",
    {
      style: { display: "flex", flexDirection: "column", gap: 2, paddingTop: 8, paddingBottom: 12 },
      onMouseEnter: () => setHovering(true),
      onMouseLeave: () => setHovering(false),
      children: [
        /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, position: "relative" }, children: [
          /* @__PURE__ */ jsxs(
            "div",
            {
              style: {
                display: "flex",
                alignItems: "center",
                gap: 6,
                whiteSpace: "nowrap",
                color: "var(--vscode-charts-blue, #3794ff)"
              },
              children: [
                /* @__PURE__ */ jsx("span", { className: "codicon codicon-git-commit" }),
                /* @__PURE__ */ jsx("span", { style: { fontWeight: 600 }, children: "Checkpoint" })
              ]
            }
          ),
          /* @__PURE__ */ jsx(
            "span",
            {
              style: {
                flex: 1,
                height: 2,
                marginTop: 2,
                backgroundImage: `linear-gradient(90deg, ${ACCENT}, ${ACCENT} 80%, rgba(0, 188, 255, 0) 99%)`
              }
            }
          ),
          /* @__PURE__ */ jsxs("div", { style: { display: "flex", gap: 2, visibility: menuVisible ? "visible" : "hidden" }, children: [
            /* @__PURE__ */ jsx(
              "button",
              {
                style: iconButton(false),
                title: "View changes in this checkpoint",
                "aria-label": "View diff",
                onClick: () => void showDiff("checkpoint"),
                children: /* @__PURE__ */ jsx("span", { className: "codicon codicon-diff-single" })
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                style: iconButton(restoreOpen),
                title: "Restore",
                "aria-label": "Restore",
                onClick: () => {
                  setRestoreOpen((open) => !open);
                  setConfirming(false);
                  setMoreOpen(false);
                },
                children: /* @__PURE__ */ jsx("span", { className: "codicon codicon-history" })
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                style: iconButton(moreOpen),
                title: "More",
                "aria-label": "More checkpoint actions",
                onClick: () => {
                  setMoreOpen((open) => !open);
                  setRestoreOpen(false);
                },
                children: /* @__PURE__ */ jsx("span", { className: "codicon codicon-kebab-vertical" })
              }
            )
          ] }),
          restoreOpen && /* @__PURE__ */ jsxs("div", { style: POPOVER, children: [
            /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 4 }, children: [
              /* @__PURE__ */ jsx("button", { style: button("secondary"), onClick: () => void restore("preview"), children: "Restore Files" }),
              /* @__PURE__ */ jsx("div", { style: MUTED, children: "Restores your project's files back to a snapshot taken at this point." })
            ] }),
            /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 4 }, children: [
              !confirming ? /* @__PURE__ */ jsx("button", { style: button("secondary"), onClick: () => setConfirming(true), children: "Restore Files & Task" }) : /* @__PURE__ */ jsxs(Fragment, { children: [
                /* @__PURE__ */ jsx("button", { style: button("primary"), onClick: () => void restore("restore"), children: "Confirm" }),
                /* @__PURE__ */ jsx("button", { style: button("secondary"), onClick: () => setConfirming(false), children: "Cancel" })
              ] }),
              confirming ? /* @__PURE__ */ jsx("div", { style: { color: "var(--vscode-errorForeground)", fontWeight: 700 }, children: "This action cannot be undone." }) : /* @__PURE__ */ jsx("div", { style: MUTED, children: "Restores your project's files and deletes all messages after this point." })
            ] })
          ] }),
          moreOpen && /* @__PURE__ */ jsxs("div", { style: { ...POPOVER, minWidth: 220 }, children: [
            /* @__PURE__ */ jsxs("button", { style: button("secondary"), onClick: () => void showDiff("from-init"), children: [
              /* @__PURE__ */ jsx("span", { className: "codicon codicon-versions", style: { marginRight: 6 } }),
              "View changes since first checkpoint"
            ] }),
            /* @__PURE__ */ jsxs("button", { style: button("secondary"), onClick: () => void showDiff("to-current"), children: [
              /* @__PURE__ */ jsx("span", { className: "codicon codicon-diff", style: { marginRight: 6 } }),
              "View changes compared to current"
            ] })
          ] })
        ] }),
        status && /* @__PURE__ */ jsx("div", { style: { ...MUTED, fontSize: "0.9em" }, children: status })
      ]
    }
  );
}
export {
  CheckpointRow as default
};
