import * as vscode from "vscode"
import { HelperAgentManager } from "../../services/helper-agent/manager"
import type { AgentMessage } from "@shofer/types"

/**
 * Open (or reveal) a read-only webview panel showing the helper agent's
 * conversation history. Called from the status bar info panel "View Chat"
 * action. The user cannot send messages — all messages come from tasks
 * via the `ask_helper_agent` tool.
 */
export function showHelperAgentChatPanel(extensionUri: vscode.Uri): void {
	const existing = HelperAgentChatPanel.current
	if (existing) {
		existing.reveal()
		return
	}
	HelperAgentChatPanel.createOrShow(extensionUri)
}

class HelperAgentChatPanel {
	static current: HelperAgentChatPanel | undefined

	private readonly _panel: vscode.WebviewPanel
	private readonly _extensionUri: vscode.Uri

	static createOrShow(extensionUri: vscode.Uri): void {
		const panel = vscode.window.createWebviewPanel(
			"shofer.helperAgentChat",
			"Helper Agent Chat",
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{
				enableScripts: false,
				localResourceRoots: [extensionUri],
			},
		)

		HelperAgentChatPanel.current = new HelperAgentChatPanel(panel, extensionUri)
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
		this._panel = panel
		this._extensionUri = extensionUri

		this._render()

		this._panel.onDidDispose(() => {
			HelperAgentChatPanel.current = undefined
		})

		// Refresh on conversation updates from all managers
		for (const mgr of HelperAgentManager.getAllInstances()) {
			mgr.onConversationUpdate(() => this._render())
			mgr.onStateChange(() => this._render())
		}
	}

	reveal(): void {
		this._panel.reveal()
	}

	private _render(): void {
		const managers = HelperAgentManager.getAllInstances()
		let messages: ReadonlyArray<AgentMessage> = []
		let state = "Standby"
		let contextUsage = { currentTokens: 0, maxTokens: 0, fillFraction: 0, isNearlyFull: false }

		if (managers.length > 0) {
			const mgr = managers[0]
			messages = mgr.getMessages()
			state = mgr.state
			contextUsage = mgr.getContextUsage()
		}

		this._panel.webview.html = this._buildHtml(state, contextUsage, messages)
	}

	private _buildHtml(
		state: string,
		usage: { currentTokens: number; maxTokens: number; fillFraction: number },
		messages: ReadonlyArray<AgentMessage>,
	): string {
		const fillPct = (usage.fillFraction * 100).toFixed(0)
		const esc = (s: string) => s.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">").replace(/\n/g, "<br>")

		const messageRows = messages
			.map((msg) => {
				const time = new Date(msg.timestamp).toLocaleTimeString()
				const sourceInfo = msg.metadata?.sourceTaskId ? ` · Task: ${msg.metadata.sourceTaskId}` : ""
				return [
					`<div class="msg msg-${msg.role}">`,
					`  <div class="meta">${msg.role} · ${time}${sourceInfo}</div>`,
					`  <div>${esc(msg.content)}</div>`,
					`</div>`,
				].join("\n")
			})
			.join("\n")

		const emptySection =
			messages.length === 0
				? `<div class="empty">No conversation history yet.<br>Tasks will ask questions via the ask_helper_agent tool.</div>`
				: ""

		return [
			`<!DOCTYPE html>`,
			`<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">`,
			`<title>Helper Agent Chat</title>`,
			`<style>`,
			`  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }`,
			`  .header { border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 8px; margin-bottom: 16px; }`,
			`  .state { font-weight: bold; } .state-Ready { color: var(--vscode-charts-green); }`,
			`  .state-Busy { color: var(--vscode-charts-yellow); } .state-Error { color: var(--vscode-errorForeground); }`,
			`  .msg { margin-bottom: 16px; padding: 8px; border-radius: 4px; }`,
			`  .msg-user { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-charts-blue); }`,
			`  .msg-assistant { background: var(--vscode-textCodeBlock-background); border-left: 3px solid var(--vscode-charts-green); }`,
			`  .msg-system { font-style: italic; opacity: 0.7; font-size: 0.9em; }`,
			`  .meta { font-size: 0.8em; opacity: 0.6; margin-bottom: 4px; }`,
			`  .empty { text-align: center; opacity: 0.5; margin-top: 40px; }`,
			`</style>`,
			`</head><body>`,
			`<div class="header">`,
			`  <div class="state state-${state}">State: ${state}</div>`,
			`  <div>Context: ${usage.currentTokens} / ${usage.maxTokens} tokens (${fillPct}%)</div>`,
			`  <div>Messages: ${messages.length}</div>`,
			`</div>`,
			emptySection,
			messageRows,
			`</body></html>`,
		].join("\n")
	}
}
