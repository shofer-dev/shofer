/**
 * Module-level logger for MCP services so they can write to Shofer's
 * OutputChannel without each taking an output-channel dependency in their
 * constructors. The sink is a minimal `OutputChannelLike` so this module stays
 * vscode-free; the VS Code channel is supplied once at activation by `extension.ts`.
 *
 * If unset (e.g. in tests), falls back to console.log so messages are not lost.
 */

import type { OutputChannelLike } from "../../utils/outputChannel"
import { mcpLog as mcpSysLog } from "../../utils/logging/subsystems"

let outputChannel: OutputChannelLike | undefined

export function setMcpOutputChannel(channel: OutputChannelLike): void {
	outputChannel = channel
}

export function mcpLog(message: string): void {
	if (outputChannel) {
		outputChannel.appendLine(message)
	}
	// Mirror to console so it also shows up in the Extension Host log,
	// which is convenient when tailing logs from a terminal/dev-tools.
	mcpSysLog.info(message)
}
