/**
 * Module-level logger for MCP services so they can write to Shofer's
 * OutputChannel without taking a `vscode.OutputChannel` dependency in their
 * constructors. Set once at activation by `extension.ts`.
 *
 * If unset (e.g. in tests), falls back to console.log so messages are not lost.
 */

import type * as vscode from "vscode"

let outputChannel: vscode.OutputChannel | undefined

export function setMcpOutputChannel(channel: vscode.OutputChannel): void {
	outputChannel = channel
}

export function mcpLog(message: string): void {
	if (outputChannel) {
		outputChannel.appendLine(message)
	}
	// Mirror to console so it also shows up in the Extension Host log,
	// which is convenient when tailing logs from a terminal/dev-tools.
	console.log(message)
}
