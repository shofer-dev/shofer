/**
 * Per-CALL transport headers for MCP tool calls — the seam that lets a plugin
 * hand one request a credential the connection could not carry.
 *
 * # Why a connection-level header is not enough
 *
 * `McpHub` binds a server's headers ONCE, when it connects, out of that server's
 * static config, and the resulting connection is hub-scoped: it outlives every
 * task the host runs and is shared by all of them. That is right for a static
 * API key. It cannot express a value that belongs to the RUN rather than to the
 * host — a short-lived, per-run credential that is re-minted while the same
 * connection stays open. The only per-call fact already crossing this boundary
 * is the task id in `_meta` (`shofer.dev/taskId`, `MCP_META_TASK_ID` in
 * `McpHub.ts`); this module makes the matching per-call HEADER possible.
 *
 * # The seam, and why it is a broadcast
 *
 * `@shofer/core` must not learn what such a credential is, where it comes from,
 * or which servers deserve one — that is deployment knowledge, and the Core
 * Self-Sufficiency Rule keeps it out. So core asks the same way it asks where a
 * task should run: `pluginRegistry.requestAll("resolve-mcp-call-headers", …)`,
 * the established broadcast for "core needs a fact a FEATURE owns, without
 * knowing which plugin (if any) provides it" — the shape `resolve-task-cwd`,
 * `resolve-task-placement` and `task-stats` already use. With no plugin
 * answering, the merge is empty, no header is added, and the call is
 * byte-for-byte the one that went out before this existed.
 *
 * It differs from the placement seams in exactly one way, deliberately: there is
 * no error channel. A plugin that cannot produce a header must degrade to the
 * pre-plugin call — a header here refines attribution and never grants access,
 * so turning its absence into a failed tool call would invent a new outage where
 * the design promises a lossless fallback.
 *
 * # How the header reaches the wire
 *
 * The MCP SDK (1.30.0) offers no per-request header API: `Protocol.request`
 * passes its options to `transport.send`, and `StreamableHTTPClientTransport.send`
 * reads only `resumptionToken`/`onresumptiontoken` from them; every header it
 * emits comes from `_commonHeaders()`, which reads the `requestInit.headers`
 * fixed at construction. Mutating that object per call would race with every
 * concurrent call on the same connection (one transport, many tasks).
 *
 * What the SDK does offer is a custom `fetch`. So the value travels from the
 * call site to that `fetch` through an {@link AsyncLocalStorage} — the same
 * mechanism core already uses to attribute logs to a task
 * (`logging/logContext.ts`) — which is per-async-context and therefore correct
 * under concurrency, with no shared mutable state to race on.
 *
 * `stdio` servers get nothing here, and need nothing: a pipe has no headers, and
 * a stdio server that wants the run's identity already receives its task id in
 * `_meta` and can resolve for itself.
 */

import { AsyncLocalStorage } from "node:async_hooks"

import type { McpCallHeadersQuestion } from "@shofer/types"
import { mcpCallHeadersAnswerSchema } from "@shofer/types"

import { pluginRegistry } from "../../plugins/plugin-registry.js"
import { mcpLog as mcpSysLog } from "../../logging/subsystems.js"

/** The broadcast method name plugins answer. */
export const RESOLVE_MCP_CALL_HEADERS = "resolve-mcp-call-headers"

/**
 * Headers a plugin may never set, because the transport owns them and a
 * plugin overriding one breaks the protocol rather than annotating the call:
 * the content negotiation the streamable-HTTP transport depends on, the MCP
 * session/protocol identifiers, the SSE resumption cursor, and the two the
 * fetch implementation computes from the body it is given.
 */
const RESERVED_HEADERS = new Set([
	"accept",
	"content-length",
	"content-type",
	"host",
	"last-event-id",
	"mcp-protocol-version",
	"mcp-session-id",
])

const storage = new AsyncLocalStorage<Readonly<Record<string, string>>>()

/**
 * The headers resolved for the MCP call whose async context we are inside, or
 * `undefined` when there are none (which is every call outside {@link withMcpCallHeaders}).
 */
export function currentMcpCallHeaders(): Readonly<Record<string, string>> | undefined {
	return storage.getStore()
}

/**
 * Run `fn` — the SDK request that performs one MCP call — with `headers` visible
 * to the transport's `fetch`. An empty or absent set runs `fn` untouched, so the
 * no-plugin path does not even enter an async context.
 */
export function withMcpCallHeaders<T>(headers: Record<string, string> | undefined, fn: () => T): T {
	if (!headers || Object.keys(headers).length === 0) {
		return fn()
	}
	return storage.run(Object.freeze({ ...headers }), fn)
}

/**
 * Ask every plugin what headers this call should carry, and merge the answers.
 *
 * **First answer wins per header name**, compared case-insensitively: two
 * plugins claiming the same header is a configuration mistake, and silently
 * letting registration order decide which credential is presented would be the
 * worse of the two failures. The loser is logged.
 *
 * Never throws: a broadcast failure resolves to "no headers", because the
 * fallback must stay lossless.
 */
export async function resolveMcpCallHeaders(question: McpCallHeadersQuestion): Promise<Record<string, string>> {
	// A pipe carries no headers; asking would only invite a plugin to hand a
	// credential to a server that cannot receive it anyway.
	if (question.type === "stdio") {
		return {}
	}

	let answers: unknown[]
	try {
		answers = await pluginRegistry.requestAll(RESOLVE_MCP_CALL_HEADERS, question, { taskId: question.taskId })
	} catch (error) {
		mcpSysLog.warn(
			`Resolving per-call headers for ${question.serverName}/${question.toolName} failed ` +
				`(${error instanceof Error ? error.message : String(error)}); the call goes out without them.`,
		)
		return {}
	}

	const merged: Record<string, string> = {}
	const claimed = new Set<string>()
	for (const answer of answers) {
		const parsed = mcpCallHeadersAnswerSchema.safeParse(answer)
		if (!parsed.success) {
			continue
		}
		for (const [rawName, value] of Object.entries(parsed.data.headers)) {
			const name = rawName.trim()
			if (!name) {
				continue
			}
			const lowered = name.toLowerCase()
			if (RESERVED_HEADERS.has(lowered)) {
				mcpSysLog.warn(
					`A plugin tried to set the reserved header "${name}" on ${question.serverName}/${question.toolName}; ignored.`,
				)
				continue
			}
			if (claimed.has(lowered)) {
				mcpSysLog.warn(
					`Two plugins answered with the header "${name}" for ${question.serverName}/${question.toolName}; ` +
						"keeping the first and ignoring the rest.",
				)
				continue
			}
			claimed.add(lowered)
			merged[name] = value
		}
	}
	return merged
}

/**
 * The `fetch` an HTTP MCP transport is constructed with: the global one, plus
 * whatever {@link withMcpCallHeaders} put in scope for this request.
 *
 * Requests the transport makes OUTSIDE a call — the initialize handshake, the
 * GET that opens the SSE stream, a reconnect — are outside that context and are
 * therefore untouched, which is correct: they belong to the connection, not to
 * any run.
 */
export const fetchWithMcpCallHeaders = (url: string | URL, init?: RequestInit): Promise<Response> => {
	const extra = currentMcpCallHeaders()
	if (!extra) {
		return fetch(url, init)
	}
	const headers = new Headers(init?.headers)
	for (const [name, value] of Object.entries(extra)) {
		headers.set(name, value)
	}
	return fetch(url, { ...init, headers })
}
