// ui/panel.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function renderInline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, (_m, c) => "<code>" + c + "</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return s;
}
function renderMarkdown(src) {
  if (!src) return "";
  const lines = src.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || "";
      const buf2 = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf2.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      out.push('<pre><code class="lang-' + escapeHtml(lang) + '">' + escapeHtml(buf2.join("\n")) + "</code></pre>");
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push("<h" + h[1].length + ">" + renderInline(h[2]) + "</h" + h[1].length + ">");
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push("<li>" + renderInline(lines[i].replace(/^\s*[-*+]\s+/, "")) + "</li>");
        i++;
      }
      out.push("<ul>" + items.join("") + "</ul>");
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push("<li>" + renderInline(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>");
        i++;
      }
      out.push("<ol>" + items.join("") + "</ol>");
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf2 = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf2.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push("<blockquote>" + renderMarkdown(buf2.join("\n")) + "</blockquote>");
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?(\s*\|\s*:?-{2,}:?)*\s*\|?\s*$/.test(lines[i + 1])) {
      const splitRow = (row) => {
        const trimmed = row.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
        return trimmed.split(/\|/).map((c) => c.trim());
      };
      const headers = splitRow(line);
      const sepCells = splitRow(lines[i + 1]);
      const aligns = sepCells.map((c) => {
        const left = c.startsWith(":");
        const right = c.endsWith(":");
        return right && left ? "center" : right ? "right" : left ? "left" : "";
      });
      const alignAttr = (idx) => aligns[idx] ? ' class="align-' + aligns[idx] + '"' : "";
      i += 2;
      const bodyRows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        bodyRows.push(splitRow(lines[i]));
        i++;
      }
      let html = "<table><thead><tr>";
      for (let c = 0; c < headers.length; c++)
        html += "<th" + alignAttr(c) + ">" + renderInline(headers[c]) + "</th>";
      html += "</tr></thead><tbody>";
      for (const row of bodyRows) {
        html += "<tr>";
        for (let c = 0; c < headers.length; c++)
          html += "<td" + alignAttr(c) + ">" + renderInline(row[c] || "") + "</td>";
        html += "</tr>";
      }
      html += "</tbody></table>";
      out.push(html);
      continue;
    }
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !/^>\s?/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push("<p>" + renderInline(buf.join(" ")) + "</p>");
  }
  return out.join("\n");
}
function prettyArgs(raw) {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
function TextPart({ text }) {
  return /* @__PURE__ */ jsx("div", { className: "part part-text md", dangerouslySetInnerHTML: { __html: renderMarkdown(text) } });
}
function ReasoningPart({ text }) {
  return /* @__PURE__ */ jsxs("details", { className: "part part-reasoning", children: [
    /* @__PURE__ */ jsx("summary", { children: "Thinking" }),
    /* @__PURE__ */ jsx("div", { className: "body", children: text })
  ] });
}
function ToolPart({ part }) {
  const inProgress = !!part.inProgress;
  const isError = !!part.isError;
  const statusCls = inProgress ? "in-progress" : isError ? "error" : "done";
  const statusText = inProgress ? "running" : isError ? "error" : "done";
  return /* @__PURE__ */ jsxs("details", { className: "part part-tool", open: inProgress, "data-testid": "tool-part", children: [
    /* @__PURE__ */ jsxs("summary", { children: [
      inProgress ? /* @__PURE__ */ jsx("span", { className: "spinner", "data-testid": "tool-spinner", "aria-hidden": "true" }) : null,
      /* @__PURE__ */ jsx("span", { className: "tool-name", children: part.name || "tool" }),
      /* @__PURE__ */ jsx("span", { className: "tool-status " + statusCls, "data-testid": "tool-status", children: statusText })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "tool-block-label", children: "Arguments" }),
    /* @__PURE__ */ jsx("pre", { children: prettyArgs(part.args) }),
    part.result !== void 0 ? /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx("div", { className: "tool-block-label", children: isError ? "Error" : "Result" }),
      /* @__PURE__ */ jsx("pre", { children: part.result })
    ] }) : null
  ] });
}
function MessageView({ msg }) {
  const time = useMemo(() => new Date(msg.timestamp).toLocaleTimeString(), [msg.timestamp]);
  const src = msg.metadata?.sourceTaskId ? " \xB7 Task: " + msg.metadata.sourceTaskId : "";
  const parts = Array.isArray(msg.parts) && msg.parts.length > 0 ? msg.parts : null;
  return /* @__PURE__ */ jsxs("div", { className: "msg msg-" + msg.role, "data-testid": "msg-" + msg.role, children: [
    /* @__PURE__ */ jsxs("div", { className: "msg-meta", children: [
      msg.role,
      " \xB7 ",
      time,
      src
    ] }),
    parts ? parts.map((p, idx) => {
      if (p.kind === "text") return /* @__PURE__ */ jsx(TextPart, { text: p.text }, idx);
      if (p.kind === "reasoning") return /* @__PURE__ */ jsx(ReasoningPart, { text: p.text }, idx);
      return /* @__PURE__ */ jsx(ToolPart, { part: p }, p.toolCallId || idx);
    }) : /* @__PURE__ */ jsx(TextPart, { text: msg.content || "" })
  ] });
}
var EMPTY_USAGE = { currentTokens: 0, maxTokens: 0, fillFraction: 0, isNearlyFull: false };
function LiveMemoryPanel({ api }) {
  const [state, setState] = useState({
    type: "state",
    state: "Standby",
    stateMessage: "Connecting to Live Memory\u2026",
    contextUsage: EMPTY_USAGE,
    messages: []
  });
  useEffect(() => {
    const unsubscribe = api.onMessage((raw) => {
      if (raw && typeof raw === "object" && raw.type === "state") {
        setState(raw);
      }
    });
    api.postMessage({ type: "ready" });
    return unsubscribe;
  }, [api]);
  const send = useCallback((type) => api.postMessage({ type }), [api]);
  const usage = state.contextUsage || EMPTY_USAGE;
  const pct = Math.round((usage.fillFraction || 0) * 100);
  const messages = state.messages || [];
  return /* @__PURE__ */ jsxs("div", { className: "lm-panel", "data-testid": "lm-panel", children: [
    /* @__PURE__ */ jsx("style", { children: PANEL_CSS }),
    /* @__PURE__ */ jsxs("div", { className: "header", children: [
      /* @__PURE__ */ jsxs("div", { className: "header-row", children: [
        /* @__PURE__ */ jsxs("div", { className: "state state-" + state.state, "data-testid": "lm-state", children: [
          "State: ",
          state.state
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "meta-line", "data-testid": "lm-ctx", children: [
          "Context: ",
          usage.currentTokens.toLocaleString(),
          " / ",
          usage.maxTokens.toLocaleString(),
          " (",
          pct,
          "%)",
          usage.isNearlyFull ? /* @__PURE__ */ jsx("span", { className: "warn", children: " \u26A0\uFE0E nearly full" }) : null
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "meta-line", children: [
          "Messages: ",
          messages.length
        ] }),
        state.stats ? /* @__PURE__ */ jsxs("div", { className: "meta-line", "data-testid": "lm-stats", children: [
          "Obs: ",
          state.stats.observations,
          " \xB7 Q&A: ",
          state.stats.questions,
          state.stats.pendingQuestions ? " \xB7 Queue: " + state.stats.pendingQuestions : ""
        ] }) : null
      ] }),
      /* @__PURE__ */ jsx("div", { className: "state-msg", children: state.stateMessage }),
      /* @__PURE__ */ jsxs("div", { className: "actions", children: [
        /* @__PURE__ */ jsx("button", { type: "button", "data-testid": "lm-refresh", onClick: () => send("getState"), children: "Refresh" }),
        /* @__PURE__ */ jsx("button", { type: "button", "data-testid": "lm-clear", onClick: () => send("clear"), children: "Clear context" }),
        /* @__PURE__ */ jsx("button", { type: "button", className: "danger", "data-testid": "lm-empty", onClick: () => send("empty"), children: "Empty memory" })
      ] })
    ] }),
    messages.length > 0 ? /* @__PURE__ */ jsx("div", { className: "messages", "data-testid": "lm-messages", children: messages.map((m) => /* @__PURE__ */ jsx(MessageView, { msg: m }, m.id)) }) : /* @__PURE__ */ jsxs("div", { className: "empty", "data-testid": "lm-empty-state", children: [
      "No conversation history yet.",
      /* @__PURE__ */ jsx("br", {}),
      "Tasks will ask questions via the ask_live_memory tool."
    ] })
  ] });
}
var PANEL_CSS = `
.lm-panel { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); line-height: 1.45; }
.lm-panel .header { position: sticky; top: 0; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-widget-border); padding: 0 0 8px 0; margin-bottom: 16px; z-index: 10; }
.lm-panel .header-row { display: flex; gap: 16px; flex-wrap: wrap; align-items: baseline; }
.lm-panel .state { font-weight: bold; }
.lm-panel .state-Ready { color: var(--vscode-charts-green); }
.lm-panel .state-Busy { color: var(--vscode-charts-yellow); }
.lm-panel .state-Initializing { color: var(--vscode-charts-blue); }
.lm-panel .state-Error { color: var(--vscode-errorForeground); }
.lm-panel .state-Standby { color: var(--vscode-descriptionForeground); }
.lm-panel .state-msg { opacity: 0.75; font-size: 0.85em; margin-top: 2px; }
.lm-panel .meta-line { font-size: 0.85em; opacity: 0.75; }
.lm-panel .warn { color: var(--vscode-charts-yellow); }
.lm-panel .actions { display: flex; gap: 8px; margin-top: 8px; }
.lm-panel .actions button { font: inherit; font-size: 0.85em; padding: 2px 10px; cursor: pointer; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-widget-border); border-radius: 3px; }
.lm-panel .actions button.danger { color: var(--vscode-errorForeground); }
.lm-panel .msg { margin-bottom: 16px; padding: 10px 12px; border-radius: 6px; border-left: 3px solid transparent; }
.lm-panel .msg-user { background: var(--vscode-textBlockQuote-background); border-left-color: var(--vscode-charts-blue); }
.lm-panel .msg-assistant { background: var(--vscode-textCodeBlock-background); border-left-color: var(--vscode-charts-green); }
.lm-panel .msg-system { font-style: italic; opacity: 0.7; font-size: 0.9em; background: transparent; }
.lm-panel .msg-meta { font-size: 0.75em; opacity: 0.6; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
.lm-panel .part { margin: 6px 0; }
.lm-panel .part-reasoning { border-left: 2px solid var(--vscode-charts-purple, #b794f4); padding-left: 8px; margin: 8px 0; }
.lm-panel .part-reasoning summary { cursor: pointer; font-size: 0.8em; opacity: 0.75; user-select: none; }
.lm-panel .part-reasoning .body { font-style: italic; opacity: 0.85; white-space: pre-wrap; margin-top: 4px; }
.lm-panel .part-tool { border: 1px solid var(--vscode-widget-border); border-radius: 4px; margin: 8px 0; overflow: hidden; }
.lm-panel .part-tool > summary { cursor: pointer; padding: 6px 10px; background: var(--vscode-editorWidget-background); font-size: 0.85em; user-select: none; display: flex; align-items: center; gap: 6px; }
.lm-panel .part-tool .tool-name { font-family: var(--vscode-editor-font-family); font-weight: bold; color: var(--vscode-textLink-foreground); }
.lm-panel .part-tool .tool-status.in-progress { color: var(--vscode-charts-yellow); }
.lm-panel .part-tool .tool-status.error { color: var(--vscode-errorForeground); }
.lm-panel .part-tool .tool-status.done { color: var(--vscode-charts-green); }
.lm-panel .part-tool .tool-block-label { font-size: 0.75em; opacity: 0.7; padding: 6px 10px 0; text-transform: uppercase; letter-spacing: 0.04em; }
.lm-panel .part-tool pre { margin: 4px 10px 8px; padding: 6px 8px; background: var(--vscode-editor-background); border-radius: 3px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 0.9em; max-height: 320px; }
.lm-panel .spinner { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-yellow); animation: lm-pulse 1.2s ease-in-out infinite; }
@keyframes lm-pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
.lm-panel .md p { margin: 0.4em 0; }
.lm-panel .md h1, .lm-panel .md h2, .lm-panel .md h3, .lm-panel .md h4 { margin: 0.6em 0 0.3em; line-height: 1.25; }
.lm-panel .md code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-size: 0.92em; }
.lm-panel .md pre { background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border); padding: 8px 10px; border-radius: 4px; overflow-x: auto; }
.lm-panel .md pre code { background: transparent; padding: 0; }
.lm-panel .md a { color: var(--vscode-textLink-foreground); }
.lm-panel .md table { border-collapse: collapse; margin: 0.4em 0; display: block; overflow-x: auto; max-width: 100%; }
.lm-panel .md th, .lm-panel .md td { border: 1px solid var(--vscode-widget-border); padding: 4px 8px; text-align: left; vertical-align: top; }
.lm-panel .empty { text-align: center; opacity: 0.5; margin-top: 40px; }
`;
export {
  LiveMemoryPanel as default
};
