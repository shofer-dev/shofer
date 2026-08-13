/**
 * plugin-mcp — the MCP **invocation** capability handed to a plugin via `ctx.mcp`
 * (design §5.6).
 *
 * A plugin granted `permissions.mcpInvoke` gets a live {@link PluginMcp} that calls a
 * tool on any MCP server the host has connected — the user's, the project's, the org's
 * and other plugins' alike. That reach is why the grant is its own flag rather than a
 * rider on `permissions.mcpServers`: contributing a server adds ONE the plugin ships,
 * invoking spans EVERY server the host is configured with.
 *
 * The hub is host-side (it owns the connections, their transports and their lifetimes),
 * so `@shofer/core` stays host-agnostic by consuming a {@link PluginMcpProvider} seam
 * the extension/CLI supplies — mirroring {@link PluginAgentProvider}. Three states:
 * - `permissions.mcpInvoke` granted ⇒ {@link createPluginMcp}: delegates to the host seam.
 * - `permissions.mcpInvoke` ungranted (but the host wired the seam) ⇒
 *   {@link createDeniedPluginMcp}: every call throws + warns (never a silent no-op, which
 *   would look to the plugin like a server that answered nothing).
 * - no seam wired (pure-core embedding) ⇒ the manager omits `ctx.mcp` entirely — there is
 *   no hub to call through.
 *
 * **A plugin call bypasses the ask/approval pipeline, deliberately.** The agent's own
 * `use_mcp_tool` is a MODEL's request and is gated per tool group by
 * `checkAutoApproval`; a plugin's call is trusted host-side code the user installed and
 * granted, and it may run from a background service with no task, on a headless node,
 * with nobody to ask. So the manifest grant IS the gate — enforced where the context is
 * assembled (`PluginManager.buildPluginMcp`), exactly like `ctx.agent` and `ctx.task`.
 * A plugin call is therefore never rendered as a chat row and never raises an approval;
 * the integrator use case this exists for is a headless worker plugin driving MCP tools
 * as part of a durable job.
 *
 * The host seam must reach the hub's own `callTool`, not a lower-level client request:
 * that is the layer resolving the per-call header seam (`services/mcp/call-headers.ts`),
 * so a plugin's call carries a RUN's credential exactly like the agent's does when the
 * caller names the task.
 */

import type { McpToolCallResponse, PluginMcp, PluginMcpCallOptions } from "@shofer/types"

import { warnPlugin } from "./plugin-warnings.js"

/**
 * Host seam that runs a plugin's MCP tool call. Supplied by the extension/CLI where the
 * `McpHub` lives, so core never reaches for the provider. Implementations delegate to
 * `McpHub.callTool` — the entry point that resolves per-call headers and stamps `_meta`
 * — and reject when no hub exists on this host.
 */
export interface PluginMcpProvider {
	/** Invoke `toolName` on `serverName`, resolving with the server's raw MCP result. */
	callTool(
		serverName: string,
		toolName: string,
		args?: Record<string, unknown>,
		opts?: PluginMcpCallOptions,
	): Promise<McpToolCallResponse>
}

/**
 * The live {@link PluginMcp} for a granted plugin: delegates to the host
 * {@link PluginMcpProvider}. Errors from the provider are surfaced to the plugin (it
 * awaits the promise) and additionally warned, so an unknown server or a hub-less host is
 * visible in the log rather than only in the plugin's own error handling.
 */
export function createPluginMcp(pluginName: string, provider: PluginMcpProvider): PluginMcp {
	return {
		async callTool(
			serverName: string,
			toolName: string,
			args?: Record<string, unknown>,
			opts?: PluginMcpCallOptions,
		): Promise<McpToolCallResponse> {
			try {
				return await provider.callTool(serverName, toolName, args, opts)
			} catch (error) {
				warnPlugin(`[plugin:${pluginName}] ctx.mcp.callTool ${serverName}/${toolName} failed: ${String(error)}`)
				throw error
			}
		},
	}
}

/**
 * The **denying** {@link PluginMcp} for a plugin that did **not** request
 * `permissions.mcpInvoke`. The call throws a descriptive error and emits a shown + logged
 * warning — the plugin fails loudly rather than silently invoking nothing. Distinct from
 * an *absent* `ctx.mcp` (no host seam): here the field is present so a plugin author gets
 * a clear "not granted" error naming the permission, rather than a missing API.
 */
export function createDeniedPluginMcp(pluginName: string, warn: (message: string) => void = warnPlugin): PluginMcp {
	return {
		// `async` so the throw surfaces as a rejected promise (matching the
		// `Promise`-returning contract), not a synchronous throw at the call site.
		async callTool(serverName: string, toolName: string): Promise<McpToolCallResponse> {
			const message =
				`[plugin:${pluginName}] ctx.mcp.callTool ${serverName}/${toolName} denied — the plugin declares no ` +
				`permissions.mcpInvoke grant. Invoking reaches every MCP server the host is configured with, not just ` +
				`the ones this plugin contributes; add "mcpInvoke": true to the manifest permissions.`
			warn(message)
			throw new Error(message)
		},
	}
}
