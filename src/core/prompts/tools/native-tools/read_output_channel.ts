import type OpenAI from "openai"

/**
 * Native tool definition for read_output_channel.
 *
 * Lists and reads VS Code "Output" panel channels. VS Code's OutputChannel API
 * is write-only with no enumeration, so this reads the per-session log files VS
 * Code persists on disk (resolved from the extension's logUri). Scoped to the
 * current session.
 */

const DESCRIPTION = `List and read VS Code "Output" panel channels (the same channels you see in the Output panel dropdown: extension logs, language servers, Git, Tasks, Shofer, etc.).

Two modes:
- **List mode** — call with NO channel to enumerate the output channels available in the current VS Code session, with their tier and size.
- **Read mode** — pass a channel name to read that channel's log. Defaults to the most-recent output (tail).

Scope: the current VS Code session only. A window reload starts a new session, so older sessions are not visible. Content is flushed asynchronously, so the last few lines may lag slightly.

Parameters:
- channel: (optional) The channel name to read (the name shown in list mode, e.g. "Shofer", "Git", "Tasks"). Omit entirely to list channels.
- search: (optional) Case-insensitive regex to filter lines (like grep). Invalid regex falls back to literal matching.
- severity: (optional) Minimum severity to include: "trace", "debug", "info", "warning", or "error". Only meaningful for log-formatted channels that emit "[level]" tokens; plain channels have no levels.
- tail: (optional) Read the most-recent bytes first. Default true. Ignored when offset is set.
- offset: (optional) Byte offset to start reading from, for pagination (reads forward from there).
- limit: (optional) Maximum bytes to return. Default 40KB, hard-capped at 256KB — output is never unlimited.

Examples:
List channels: {}
Read latest Git log: { "channel": "Git" }
Errors only in an extension channel: { "channel": "ESLint", "severity": "error" }
Grep a channel: { "channel": "Shofer", "search": "task .* failed" }`

export default {
	type: "function",
	function: {
		name: "read_output_channel",
		description: DESCRIPTION,
		// strict mode intentionally disabled: every parameter is optional (list
		// mode takes no args), and strict mode would force the model to emit
		// explicit nulls for all of them.
		parameters: {
			type: "object",
			properties: {
				channel: {
					type: "string",
					description: "Channel name to read (from list mode). Omit to list channels.",
				},
				search: {
					type: "string",
					description: "Case-insensitive regex line filter (read mode). Omit if not filtering.",
				},
				severity: {
					type: "string",
					enum: ["trace", "debug", "info", "warning", "error"],
					description: "Minimum severity to include (read mode, log-formatted channels only).",
				},
				tail: {
					type: "boolean",
					description: "Read most-recent bytes first (default true). Ignored when offset is set.",
				},
				offset: {
					type: "number",
					description: "Byte offset to start reading from (pagination).",
				},
				limit: {
					type: "number",
					description: "Maximum bytes to return (default 40KB, hard cap 256KB).",
				},
			},
			required: [],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
