import { z } from "zod"
import type { ToolGroup } from "./tool.js"

/**
 * Maximum number of MCP tools that can be enabled before showing a warning.
 * LLMs tend to perform poorly when given too many tools to choose from.
 */
export const MAX_MCP_TOOLS_THRESHOLD = 100

/**
 * McpServerUse
 */

export interface McpServerUse {
	type: string
	serverName: string
	toolName?: string
	uri?: string
	/**
	 * When true, this `use_mcp_server` envelope was synthesised by Shofer to
	 * visualise an external VS Code language-model tool call (registered via
	 * `vscode.lm.tools`) — not a real MCP server invocation. The
	 * auto-approval check uses this flag to bypass `alwaysAllowMcp` gating
	 * since the user already opted in by installing the providing extension.
	 */
	external_lm_tool?: boolean
}

/**
 * McpExecutionStatus
 */

export const mcpExecutionStatusSchema = z.discriminatedUnion("status", [
	z.object({
		executionId: z.string(),
		status: z.literal("started"),
		serverName: z.string(),
		toolName: z.string(),
	}),
	z.object({
		executionId: z.string(),
		status: z.literal("output"),
		response: z.string(),
	}),
	z.object({
		executionId: z.string(),
		status: z.literal("completed"),
		response: z.string().optional(),
	}),
	z.object({
		executionId: z.string(),
		status: z.literal("error"),
		error: z.string().optional(),
	}),
])

export type McpExecutionStatus = z.infer<typeof mcpExecutionStatusSchema>

/**
 * McpServer
 */

export type McpServer = {
	name: string
	config: string
	status: "connected" | "connecting" | "disconnected"
	error?: string
	errorHistory?: McpErrorEntry[]
	tools?: McpTool[]
	resources?: McpResource[]
	resourceTemplates?: McpResourceTemplate[]
	disabled?: boolean
	timeout?: number
	source?: "global" | "project"
	projectPath?: string
	instructions?: string
}

export type McpTool = {
	name: string
	description?: string
	inputSchema?: object
	enabledForPrompt?: boolean
	group?: ToolGroup
}

export type McpResource = {
	uri: string
	name: string
	mimeType?: string
	description?: string
}

export type McpResourceTemplate = {
	uriTemplate: string
	name: string
	description?: string
	mimeType?: string
}

export type McpResourceResponse = {
	_meta?: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
	contents: Array<{
		uri: string
		mimeType?: string
		text?: string
		blob?: string
	}>
}

export type McpToolCallResponse = {
	_meta?: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
	content: Array<
		| {
				type: "text"
				text: string
		  }
		| {
				type: "image"
				data: string
				mimeType: string
		  }
		| {
				type: "audio"
				data: string
				mimeType: string
		  }
		| {
				type: "resource"
				resource: {
					uri: string
					mimeType?: string
					text?: string
					blob?: string
				}
		  }
		| {
				// `resource_link` was added to the MCP content union in
				// @modelcontextprotocol/sdk ≥1.12 — the server returns a
				// pointer to a resource without inlining its bytes.
				type: "resource_link"
				uri: string
				name: string
				title?: string
				description?: string
				mimeType?: string
				_meta?: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
		  }
	>
	isError?: boolean
}

export type McpErrorEntry = {
	message: string
	timestamp: number
	level: "error" | "warn" | "info"
}

/**
 * Result of counting enabled MCP tools across servers.
 */
export interface EnabledMcpToolsCount {
	/** Number of enabled and connected MCP servers */
	enabledServerCount: number
	/** Total number of enabled tools across all enabled servers */
	enabledToolCount: number
}

/**
 * Count the number of enabled MCP tools across all enabled and connected servers.
 * This is a pure function that can be used in both backend and frontend contexts.
 *
 * @param servers - Array of MCP server objects
 * @returns Object with enabledToolCount and enabledServerCount
 *
 * @example
 * const { enabledToolCount, enabledServerCount } = countEnabledMcpTools(mcpServers)
 * if (enabledToolCount > MAX_MCP_TOOLS_THRESHOLD) {
 *   // Show warning
 * }
 */
export function countEnabledMcpTools(servers: McpServer[]): EnabledMcpToolsCount {
	let serverCount = 0
	let toolCount = 0

	for (const server of servers) {
		// Skip disabled servers
		if (server.disabled) continue

		// Skip servers that are not connected
		if (server.status !== "connected") continue

		serverCount++

		// Count enabled tools on this server
		if (server.tools) {
			for (const tool of server.tools) {
				// Tool is enabled if enabledForPrompt is undefined (default) or true
				if (tool.enabledForPrompt !== false) {
					toolCount++
				}
			}
		}
	}

	return { enabledToolCount: toolCount, enabledServerCount: serverCount }
}

/**
 * The `"resolve-mcp-call-headers"` plugin broadcast — asked once per MCP tool
 * call, so a plugin can supply transport headers for **that** call.
 *
 * Core knows a tool call is about to leave for a server; it does not know that
 * some deployments give a RUN a short-lived credential the server wants to see.
 * A transport's headers are bound once, at connect, from static config, and one
 * connection serves every task the host ever runs — so a per-run value has no
 * way in. Hence the question: every plugin is offered it and the answers are
 * merged (see `resolveMcpCallHeaders` in `@shofer/core`).
 *
 * The question carries everything a resolver needs to decide **whether this is
 * a server it should hand a credential to at all** — a plugin must never answer
 * blind, since an answer is a secret sent to whatever URL that server names.
 * `source` and `url` are how a resolver tells a host-injected server from one a
 * user wrote into their own `.shofer/mcp.json`.
 */
export interface McpCallHeadersQuestion {
	/** The MCP server the call is addressed to, as named in its config. */
	serverName: string
	/** Which scope defined the server: `global` (org/user `mcp.json`) or `project`. */
	source: "global" | "project"
	/** The server's transport. Only the HTTP transports can carry headers. */
	type: "stdio" | "sse" | "streamable-http"
	/** The server's URL, for the HTTP transports; absent for `stdio`. */
	url?: string
	/** The tool being called. */
	toolName: string
	/** The run the call belongs to — the same id `_meta['shofer.dev/taskId']` carries. */
	taskId?: string
}

/**
 * A plugin's answer to {@link McpCallHeadersQuestion}: the headers to add to
 * this one request.
 *
 * There is deliberately **no error channel** here, unlike the
 * `"resolve-task-placement"` / `"resolve-task-cwd"` answers. Those exist to make
 * a plugin's failure fail the operation, because silently running the task
 * somewhere else is the outcome the seam exists to prevent. A header is the
 * opposite: it is additive attribution, and a resolver that cannot produce one
 * must degrade to the call going out exactly as it did before the plugin
 * existed. So "no headers" is spelled `{ headers: {} }`, and a plugin that does
 * not recognise the question throws — which the broadcast reads as no answer.
 */
export const mcpCallHeadersAnswerSchema = z.object({
	headers: z.record(z.string()),
})

export type McpCallHeadersAnswer = z.infer<typeof mcpCallHeadersAnswerSchema>
