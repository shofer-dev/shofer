// ui/badge.tsx
import { useEffect, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
function SecondBrainBadge({ api }) {
  const [snapshot, setSnapshot] = useState();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const off = api.onMessage((message) => {
      const m = message;
      if (m?.type === "state" && m.snapshot) setSnapshot(m.snapshot);
    });
    api.postMessage({ command: "getState" });
    return off;
  }, [api]);
  const dot = !snapshot?.consent ? "var(--vscode-charts-yellow, #cca700)" : snapshot.muted ? "var(--vscode-descriptionForeground)" : "var(--vscode-charts-green, #89d185)";
  const totalCost = snapshot?.tasks.reduce((sum, t) => sum + t.costUsd, 0) ?? 0;
  const totalPasses = snapshot?.tasks.reduce((sum, t) => sum + t.passes, 0) ?? 0;
  return /* @__PURE__ */ jsxs("span", { style: { position: "relative", display: "inline-flex", alignItems: "center" }, children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        onClick: () => setOpen((v) => !v),
        title: !snapshot?.consent ? "Second Brain needs your billed-AI approval (Settings \u2192 Plugins)" : snapshot.muted ? "Second Brain is muted" : `Second Brain watching \xB7 ${totalPasses} passes \xB7 $${totalCost.toFixed(2)}`,
        style: {
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "0 4px",
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          color: "var(--vscode-foreground)"
        },
        children: [
          /* @__PURE__ */ jsx("span", { style: { fontSize: "0.95em" }, children: "\u{1F9E0}" }),
          /* @__PURE__ */ jsx("span", { style: { width: 6, height: 6, borderRadius: "50%", background: dot } })
        ]
      }
    ),
    open && snapshot && /* @__PURE__ */ jsxs(
      "div",
      {
        style: {
          position: "absolute",
          bottom: "120%",
          right: 0,
          zIndex: 50,
          minWidth: 260,
          maxWidth: 380,
          padding: 10,
          borderRadius: 4,
          fontSize: "0.85em",
          background: "var(--vscode-editorWidget-background)",
          border: "1px solid var(--vscode-editorWidget-border, transparent)",
          color: "var(--vscode-foreground)",
          boxShadow: "0 2px 8px rgba(0,0,0,.3)"
        },
        children: [
          /* @__PURE__ */ jsxs("div", { style: { fontWeight: 600, marginBottom: 6 }, children: [
            "Second Brain",
            " ",
            !snapshot.consent ? "\xB7 needs approval" : snapshot.muted ? "\xB7 muted" : "\xB7 watching"
          ] }),
          snapshot.tasks.length === 0 && /* @__PURE__ */ jsx("div", { children: "No observed task yet." }),
          snapshot.tasks.map((t) => /* @__PURE__ */ jsxs("div", { style: { marginBottom: 6 }, children: [
            /* @__PURE__ */ jsxs("div", { style: { opacity: 0.8 }, children: [
              "task ",
              t.taskId.slice(0, 8),
              " \xB7 ",
              t.passes,
              " passes \xB7 ",
              t.advisoriesDelivered,
              " advisories \xB7 $",
              t.costUsd.toFixed(3)
            ] }),
            t.lastVerdicts?.map((v) => /* @__PURE__ */ jsxs("div", { style: { paddingLeft: 8, opacity: 0.7 }, children: [
              v.detector,
              " \u2192 ",
              v.verdict,
              v.note ? ` ${v.note}` : ""
            ] }, v.detector))
          ] }, t.taskId))
        ]
      }
    )
  ] });
}
export {
  SecondBrainBadge as default
};
