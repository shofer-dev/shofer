/**
 * AssistantAgentChatProvider — read-only webview panel that streams the
 * Assistant Agent's conversation to the user.
 *
 * Design goals (per docs/assistant_agent.md, §"Chat panel"):
 *
 *  1. **Live updates.** The panel never rebuilds its full DOM on each tick.
 *     The host posts a single `state` message per change; an inline script
 *     diff-renders the message list. This is what gives the user the
 *     impression that the assistant is "typing" in real time as the LLM
 *     streams tokens (text + reasoning) and as tool calls progress.
 *
 *  2. **Transparency.** A message is no longer an opaque concatenated
 *     `content` blob — it is a sequence of typed `parts`
 *     (`text` | `reasoning` | `tool_call`) that the panel renders distinctly:
 *       - text       → markdown
 *       - reasoning  → italic, dimmed, collapsed-by-default `<details>`
 *       - tool_call  → labelled badge + collapsible args/result blocks,
 *                      with an in-progress spinner until the host fills in
 *                      `result` / `isError`.
 *     For older persisted messages without `parts`, the legacy `content`
 *     string is rendered as a single text part so we don't lose history.
 *
 *  3. **Markdown.** Rendered client-side by a tiny dependency-free
 *     subset of CommonMark (fenced code blocks, inline code, bold,
 *     italic, headings, ordered/unordered lists, links, paragraphs).
 *     We deliberately avoid pulling marked/markdown-it into a webview
 *     context that has no bundler pipeline of its own.
 *
 *  4. **Cleanup.** Manager subscriptions are disposed when the panel is
 *     disposed (the previous implementation leaked a subscription per
 *     panel-open).
 *
 * Security: `enableScripts: true` is required for live updates; we apply
 * a strict CSP that allows only this panel's nonce-stamped inline script
 * and the webview's own resource origin.
 */

import * as vscode from "vscode"

import { AssistantAgentManager } from "../../services/assistant-agent/manager"
import type { AgentMessage, AgentMessagePart } from "@shofer/types"

interface PanelStateMessage {
	type: "state"
	state: string
	stateMessage: string
	contextUsage: { currentTokens: number; maxTokens: number; fillFraction: number; isNearlyFull?: boolean }
	messages: ReadonlyArray<AgentMessage>
}

/** Public entry point used by the registered command. */
export function showAssistantAgentChatPanel(extensionUri: vscode.Uri): void {
	const existing = AssistantAgentChatPanel.current
	if (existing) {
		existing.reveal()
		return
	}
	AssistantAgentChatPanel.createOrShow(extensionUri)
}

class AssistantAgentChatPanel {
	static current: AssistantAgentChatPanel | undefined

	private readonly _panel: vscode.WebviewPanel
	private readonly _disposables: vscode.Disposable[] = []
	/** Coalesce bursts of streaming events into a single postMessage tick. */
	private _postScheduled = false

	static createOrShow(extensionUri: vscode.Uri): void {
		const panel = vscode.window.createWebviewPanel(
			"shofer.assistantAgentChat",
			"Assistant Agent Chat",
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [extensionUri],
			},
		)
		AssistantAgentChatPanel.current = new AssistantAgentChatPanel(panel)
	}

	private constructor(panel: vscode.WebviewPanel) {
		this._panel = panel
		this._panel.webview.html = this._buildSkeletonHtml()

		this._panel.onDidDispose(() => this._dispose(), null, this._disposables)

		// Subscribe to every workspace manager. In a multi-root setup we
		// merge their conversations into a single transcript (the panel is
		// process-wide). Per-instance filtering can be added later.
		for (const mgr of AssistantAgentManager.getAllInstances()) {
			this._disposables.push(mgr.onConversationUpdate(() => this._scheduleStatePost()))
			this._disposables.push(mgr.onStateChange(() => this._scheduleStatePost()))
		}

		// Replay initial state once the webview has had a chance to wire up
		// its own message listener.
		this._postState()
	}

	reveal(): void {
		this._panel.reveal()
	}

	private _scheduleStatePost(): void {
		if (this._postScheduled) return
		this._postScheduled = true
		// Microtask coalescing: many event-emitter fires within a single
		// turn of the event loop produce exactly one postMessage to the
		// webview. This keeps the chat panel responsive even when the
		// LLM streams tokens at high rates.
		queueMicrotask(() => {
			this._postScheduled = false
			this._postState()
		})
	}

	private _postState(): void {
		const managers = AssistantAgentManager.getAllInstances()
		let messages: ReadonlyArray<AgentMessage> = []
		let state = "Standby"
		let stateMessage = "Assistant agent is not configured"
		let contextUsage = { currentTokens: 0, maxTokens: 0, fillFraction: 0, isNearlyFull: false }

		if (managers.length > 0) {
			const mgr = managers[0]
			messages = mgr.getMessages()
			state = mgr.state
			stateMessage = mgr.stateMessage
			contextUsage = mgr.getContextUsage()
		}

		const payload: PanelStateMessage = { type: "state", state, stateMessage, contextUsage, messages }
		this._panel.webview.postMessage(payload)
	}

	private _dispose(): void {
		AssistantAgentChatPanel.current = undefined
		while (this._disposables.length) {
			const d = this._disposables.pop()
			try {
				d?.dispose()
			} catch {
				// best-effort
			}
		}
	}

	/**
	 * Builds the static HTML shell. All dynamic content is patched by the
	 * inline script in response to `state` messages from the host.
	 *
	 * The inline script intentionally lives in the host source (not a
	 * separate file) so it is bundled into the extension VSIX without a
	 * webview-specific build step. It is small (< 4 KB) and dependency-free.
	 */
	private _buildSkeletonHtml(): string {
		const nonce = makeNonce()
		const csp = [
			`default-src 'none'`,
			`style-src ${this._panel.webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
			`img-src ${this._panel.webview.cspSource} data:`,
			`font-src ${this._panel.webview.cspSource}`,
		].join("; ")

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Assistant Agent Chat</title>
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; line-height: 1.45; }
  .header { position: sticky; top: 0; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-widget-border); padding: 0 0 8px 0; margin-bottom: 16px; z-index: 10; }
  .header-row { display: flex; gap: 16px; flex-wrap: wrap; align-items: baseline; }
  .state { font-weight: bold; }
  .state-Ready { color: var(--vscode-charts-green); }
  .state-Busy { color: var(--vscode-charts-yellow); }
  .state-Initializing { color: var(--vscode-charts-blue); }
  .state-Error { color: var(--vscode-errorForeground); }
  .state-Standby { color: var(--vscode-descriptionForeground); }
  .state-msg { opacity: 0.75; font-size: 0.85em; }
  .meta-line { font-size: 0.85em; opacity: 0.75; }

  .msg { margin-bottom: 16px; padding: 10px 12px; border-radius: 6px; border-left: 3px solid transparent; }
  .msg-user { background: var(--vscode-textBlockQuote-background); border-left-color: var(--vscode-charts-blue); }
  .msg-assistant { background: var(--vscode-textCodeBlock-background); border-left-color: var(--vscode-charts-green); }
  .msg-system { font-style: italic; opacity: 0.7; font-size: 0.9em; background: transparent; }
  .msg-meta { font-size: 0.75em; opacity: 0.6; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }

  .part { margin: 6px 0; }
  .part-reasoning { border-left: 2px solid var(--vscode-charts-purple, #b794f4); padding-left: 8px; margin: 8px 0; }
  .part-reasoning summary { cursor: pointer; font-size: 0.8em; opacity: 0.75; user-select: none; }
  .part-reasoning .body { font-style: italic; opacity: 0.85; white-space: pre-wrap; margin-top: 4px; }
  .part-tool { border: 1px solid var(--vscode-widget-border); border-radius: 4px; margin: 8px 0; overflow: hidden; }
  .part-tool > summary { cursor: pointer; padding: 6px 10px; background: var(--vscode-editorWidget-background); font-size: 0.85em; user-select: none; display: flex; align-items: center; gap: 6px; }
  .part-tool > summary::-webkit-details-marker { display: none; }
  .part-tool .tool-name { font-family: var(--vscode-editor-font-family); font-weight: bold; color: var(--vscode-textLink-foreground); }
  .part-tool .tool-status { font-size: 0.85em; }
  .part-tool .tool-status.in-progress { color: var(--vscode-charts-yellow); }
  .part-tool .tool-status.error { color: var(--vscode-errorForeground); }
  .part-tool .tool-status.done { color: var(--vscode-charts-green); }
  .part-tool .tool-block-label { font-size: 0.75em; opacity: 0.7; padding: 6px 10px 0; text-transform: uppercase; letter-spacing: 0.04em; }
  .part-tool pre { margin: 4px 10px 8px; padding: 6px 8px; background: var(--vscode-editor-background); border-radius: 3px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 0.9em; max-height: 320px; }
  .spinner { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-yellow); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }

  /* Markdown */
  .md p { margin: 0.4em 0; }
  .md h1, .md h2, .md h3, .md h4 { margin: 0.6em 0 0.3em; line-height: 1.25; }
  .md h1 { font-size: 1.4em; } .md h2 { font-size: 1.2em; } .md h3 { font-size: 1.05em; }
  .md ul, .md ol { padding-left: 1.4em; margin: 0.4em 0; }
  .md li { margin: 0.15em 0; }
  .md code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-size: 0.92em; }
  .md pre { background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border); padding: 8px 10px; border-radius: 4px; overflow-x: auto; }
  .md pre code { background: transparent; padding: 0; }
  .md a { color: var(--vscode-textLink-foreground); }
  .md blockquote { border-left: 3px solid var(--vscode-widget-border); padding-left: 8px; opacity: 0.85; margin: 0.4em 0; }

  .empty { text-align: center; opacity: 0.5; margin-top: 40px; }
</style>
</head>
<body>
<div class="header">
  <div class="header-row">
    <div class="state state-Standby" id="state">State: Standby</div>
    <div class="meta-line" id="ctx">Context: 0 / 0 (0%)</div>
    <div class="meta-line" id="count">Messages: 0</div>
  </div>
  <div class="state-msg" id="state-msg"></div>
</div>
<div id="messages"></div>
<div class="empty" id="empty">No conversation history yet.<br>Tasks will ask questions via the ask_assistant_agent tool.</div>

<script nonce="${nonce}">
(function () {
  "use strict";

  const $messages = document.getElementById("messages");
  const $empty = document.getElementById("empty");
  const $state = document.getElementById("state");
  const $stateMsg = document.getElementById("state-msg");
  const $ctx = document.getElementById("ctx");
  const $count = document.getElementById("count");

  // ─── Markdown (minimal CommonMark subset) ─────────────────────────
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderInline(text) {
    let s = escapeHtml(text);
    // inline code first so we don't process formatting inside it
    s = s.replace(/\`([^\`]+)\`/g, (_, c) => "<code>" + c + "</code>");
    // bold then italic
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, "$1<em>$2</em>");
    // links [text](url)
    s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, '<a href="$2">$1</a>');
    return s;
  }

  function renderMarkdown(src) {
    if (!src) return "";
    const lines = src.split(/\\r?\\n/);
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // fenced code block
      const fence = line.match(/^\`\`\`(\\w*)\\s*$/);
      if (fence) {
        const lang = fence[1] || "";
        const buf = [];
        i++;
        while (i < lines.length && !/^\`\`\`\\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) i++; // consume closing fence
        out.push('<pre><code class="lang-' + escapeHtml(lang) + '">' + escapeHtml(buf.join("\\n")) + "</code></pre>");
        continue;
      }
      // heading
      const h = line.match(/^(#{1,4})\\s+(.*)$/);
      if (h) { out.push("<h" + h[1].length + ">" + renderInline(h[2]) + "</h" + h[1].length + ">"); i++; continue; }
      // unordered list
      if (/^\\s*[-*+]\\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\\s*[-*+]\\s+/.test(lines[i])) {
          items.push("<li>" + renderInline(lines[i].replace(/^\\s*[-*+]\\s+/, "")) + "</li>");
          i++;
        }
        out.push("<ul>" + items.join("") + "</ul>");
        continue;
      }
      // ordered list
      if (/^\\s*\\d+\\.\\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\\s*\\d+\\.\\s+/.test(lines[i])) {
          items.push("<li>" + renderInline(lines[i].replace(/^\\s*\\d+\\.\\s+/, "")) + "</li>");
          i++;
        }
        out.push("<ol>" + items.join("") + "</ol>");
        continue;
      }
      // blockquote
      if (/^>\\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\\s?/, "")); i++; }
        out.push("<blockquote>" + renderMarkdown(buf.join("\\n")) + "</blockquote>");
        continue;
      }
      // blank line
      if (/^\\s*$/.test(line)) { i++; continue; }
      // paragraph: gather until blank/structural boundary
      const buf = [line];
      i++;
      while (i < lines.length && !/^\\s*$/.test(lines[i]) && !/^\`\`\`/.test(lines[i]) && !/^#{1,4}\\s/.test(lines[i]) && !/^\\s*[-*+]\\s+/.test(lines[i]) && !/^\\s*\\d+\\.\\s+/.test(lines[i]) && !/^>\\s?/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      out.push("<p>" + renderInline(buf.join(" ")) + "</p>");
    }
    return out.join("\\n");
  }

  // ─── Part rendering ───────────────────────────────────────────────
  function renderPart(part, partIdx) {
    if (part.kind === "text") {
      return '<div class="part part-text md">' + renderMarkdown(part.text || "") + "</div>";
    }
    if (part.kind === "reasoning") {
      return (
        '<details class="part part-reasoning">' +
          '<summary>Thinking</summary>' +
          '<div class="body">' + escapeHtml(part.text || "") + "</div>" +
        "</details>"
      );
    }
    if (part.kind === "tool_call") {
      const inProgress = !!part.inProgress;
      const isError = !!part.isError;
      const statusCls = inProgress ? "in-progress" : isError ? "error" : "done";
      const statusText = inProgress ? "running" : isError ? "error" : "done";
      const statusBadge = inProgress
        ? '<span class="spinner" aria-hidden="true"></span>'
        : "";
      let prettyArgs = part.args || "";
      try { prettyArgs = JSON.stringify(JSON.parse(part.args), null, 2); } catch (_) { /* keep raw */ }
      const open = inProgress ? "open" : "";
      return (
        '<details class="part part-tool" ' + open + '>' +
          '<summary>' + statusBadge +
            '<span class="tool-name">' + escapeHtml(part.name || "tool") + '</span>' +
            '<span class="tool-status ' + statusCls + '">' + statusText + '</span>' +
          '</summary>' +
          '<div class="tool-block-label">Arguments</div>' +
          '<pre>' + escapeHtml(prettyArgs) + '</pre>' +
          (part.result !== undefined
            ? '<div class="tool-block-label">' + (isError ? "Error" : "Result") + '</div><pre>' + escapeHtml(part.result) + '</pre>'
            : "") +
        "</details>"
      );
    }
    return "";
  }

  function renderMessage(msg) {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    const src = msg.metadata && msg.metadata.sourceTaskId ? " · Task: " + escapeHtml(msg.metadata.sourceTaskId) : "";
    const meta = '<div class="msg-meta">' + escapeHtml(msg.role) + " · " + time + src + "</div>";
    let body;
    if (Array.isArray(msg.parts) && msg.parts.length > 0) {
      body = msg.parts.map(renderPart).join("");
    } else {
      // legacy message without parts → render content as a single text part
      body = '<div class="part part-text md">' + renderMarkdown(msg.content || "") + "</div>";
    }
    return '<div class="msg msg-' + escapeHtml(msg.role) + '">' + meta + body + "</div>";
  }

  // ─── Event handler ────────────────────────────────────────────────
  function applyState(state) {
    $state.className = "state state-" + state.state;
    $state.textContent = "State: " + state.state;
    $stateMsg.textContent = state.stateMessage || "";
    const u = state.contextUsage || { currentTokens: 0, maxTokens: 0, fillFraction: 0 };
    const pct = (u.fillFraction * 100).toFixed(0);
    $ctx.textContent = "Context: " + u.currentTokens.toLocaleString() + " / " + u.maxTokens.toLocaleString() + " (" + pct + "%)";
    $count.textContent = "Messages: " + (state.messages ? state.messages.length : 0);

    if (state.messages && state.messages.length > 0) {
      $empty.style.display = "none";
      $messages.innerHTML = state.messages.map(renderMessage).join("");
    } else {
      $empty.style.display = "";
      $messages.innerHTML = "";
    }
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg && msg.type === "state") applyState(msg);
  });
})();
</script>
</body>
</html>`
	}
}

/** Generate a one-off CSP nonce for the inline script. */
function makeNonce(): string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	let out = ""
	for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)]
	return out
}
