// plugins/live-memory/ui/badge.tsx
import { useEffect, useMemo, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
var DOT_COLOR = {
  Standby: "var(--vscode-descriptionForeground)",
  Initializing: "var(--vscode-charts-yellow, #d7ba7d)",
  Ready: "var(--vscode-charts-green, #89d185)",
  Busy: "var(--vscode-charts-yellow, #d7ba7d)",
  Error: "var(--vscode-errorForeground, #f14c4c)",
  Stopping: "var(--vscode-charts-orange, #d18616)"
};
var PULSING = /* @__PURE__ */ new Set(["Initializing", "Busy", "Stopping"]);
function LiveMemoryBadge({ api }) {
  const [s, setS] = useState({ state: "Standby" });
  useEffect(() => {
    const off = api.onMessage((raw) => {
      const m = raw;
      if (m && m.type === "state") {
        setS({ state: m.state, stateMessage: m.stateMessage, contextUsage: m.contextUsage, stats: m.stats });
      }
    });
    api.postMessage({ type: "ready" });
    return off;
  }, [api]);
  const fillPct = useMemo(() => {
    const u = s.contextUsage;
    return u && u.maxTokens > 0 ? Math.round(u.fillFraction * 100) : void 0;
  }, [s.contextUsage]);
  const tooltip = useMemo(() => {
    const lines = [`Live Memory: ${s.state}`];
    if (s.stateMessage) lines.push(s.stateMessage);
    if (fillPct !== void 0) lines.push(`Context: ${fillPct}% full`);
    if (s.stats?.pendingQuestions) lines.push(`Queue: ${s.stats.pendingQuestions} pending`);
    return lines.join("\n");
  }, [s, fillPct]);
  const color = DOT_COLOR[s.state] ?? DOT_COLOR.Standby;
  const pulse = PULSING.has(s.state);
  return /* @__PURE__ */ jsxs(
    "span",
    {
      className: "lm-badge",
      title: tooltip,
      "aria-label": tooltip,
      role: "img",
      style: {
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 20,
        height: 20,
        opacity: 0.85,
        color: "var(--vscode-foreground)"
      },
      children: [
        /* @__PURE__ */ jsx(
          "svg",
          {
            width: "15",
            height: "15",
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: "2",
            strokeLinecap: "round",
            strokeLinejoin: "round",
            "aria-hidden": "true",
            children: /* @__PURE__ */ jsx("path", { d: "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" })
          }
        ),
        /* @__PURE__ */ jsx(
          "span",
          {
            style: {
              position: "absolute",
              top: 1,
              right: 1,
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: color,
              animation: pulse ? "lm-badge-pulse 1.2s ease-in-out infinite" : void 0
            }
          }
        ),
        /* @__PURE__ */ jsx("style", { children: "@keyframes lm-badge-pulse{0%,100%{opacity:.35}50%{opacity:1}}" })
      ]
    }
  );
}
export {
  LiveMemoryBadge as default
};
