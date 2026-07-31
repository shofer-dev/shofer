// ui/panel.tsx
import { useCallback, useEffect, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
var box = {
  border: "1px solid var(--vscode-editorWidget-border, transparent)",
  borderRadius: 4,
  padding: 8,
  marginBottom: 8
};
function SecondBrainPanel({ api }) {
  const [stats, setStats] = useState();
  const [why, setWhy] = useState([]);
  const [error, setError] = useState();
  const refresh = useCallback(() => {
    void api.request("stats").then((s) => setStats(s)).catch((e) => setError(String(e)));
    void api.request("why").then((w) => setWhy(w)).catch(() => {
    });
  }, [api]);
  useEffect(refresh, [refresh]);
  return /* @__PURE__ */ jsxs("div", { style: { padding: 10, fontSize: "0.9em", color: "var(--vscode-foreground)" }, children: [
    /* @__PURE__ */ jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }, children: [
      /* @__PURE__ */ jsx("b", { children: "\u{1F9E0} Second Brain" }),
      /* @__PURE__ */ jsx("button", { onClick: refresh, style: { cursor: "pointer" }, children: "refresh" })
    ] }),
    error && /* @__PURE__ */ jsx("div", { style: { color: "var(--vscode-errorForeground)" }, children: error }),
    stats && /* @__PURE__ */ jsxs("div", { style: box, children: [
      /* @__PURE__ */ jsx("div", { children: !stats.consent ? "needs billed-AI approval" : stats.muted ? "muted" : "watching" }),
      stats.tasks.map((t) => /* @__PURE__ */ jsxs("div", { style: { marginTop: 6 }, children: [
        /* @__PURE__ */ jsxs("div", { children: [
          "task ",
          t.taskId.slice(0, 8),
          " \u2014 ",
          t.passes,
          " passes \xB7 digest",
          " ",
          Math.round(t.digestChars / 1e3),
          "k chars \xB7 observed ",
          Math.round(t.spoolChars / 1e3),
          "k \xB7 ",
          t.advisoriesDelivered,
          " advisories \xB7 $",
          t.costUsd.toFixed(3)
        ] }),
        Object.entries(t.uptake).map(([detector, u]) => /* @__PURE__ */ jsxs("div", { style: { paddingLeft: 10, opacity: 0.75 }, children: [
          detector,
          ": ",
          u.adopted,
          "/",
          u.delivered,
          " adopted"
        ] }, detector))
      ] }, t.taskId)),
      /* @__PURE__ */ jsxs("div", { style: { marginTop: 6, opacity: 0.6 }, children: [
        "overrides: ",
        stats.cataloguePath
      ] })
    ] }),
    why.map((entry) => /* @__PURE__ */ jsxs("div", { style: box, children: [
      /* @__PURE__ */ jsxs("div", { style: { fontWeight: 600 }, children: [
        "task ",
        entry.taskId.slice(0, 8)
      ] }),
      entry.advisories.length === 0 && entry.drops.length === 0 && /* @__PURE__ */ jsx("div", { style: { opacity: 0.7 }, children: "all silent so far" }),
      entry.advisories.map((a) => /* @__PURE__ */ jsxs("div", { style: { marginTop: 6 }, children: [
        /* @__PURE__ */ jsxs("div", { children: [
          "[",
          a.detector,
          " ",
          a.confidence.toFixed(2),
          a.humanOnly ? " \xB7 you only" : "",
          "] ",
          a.headline,
          a.outcome ? ` \u2192 ${a.outcome.verdict}` : " \u2192 open"
        ] }),
        /* @__PURE__ */ jsx("div", { style: { opacity: 0.75, whiteSpace: "pre-wrap" }, children: a.body }),
        a.evidence.length > 0 && /* @__PURE__ */ jsxs("div", { style: { opacity: 0.6 }, children: [
          "evidence: ",
          a.evidence.join("; ")
        ] })
      ] }, a.id)),
      entry.drops.map((d, i) => /* @__PURE__ */ jsxs("div", { style: { marginTop: 4, opacity: 0.6 }, children: [
        "gated [",
        d.detector,
        "] \u201C",
        d.headline,
        "\u201D \u2014 ",
        d.reason
      ] }, i))
    ] }, entry.taskId))
  ] });
}
export {
  SecondBrainPanel as default
};
