/**
 * llm — the fork's provider adapter over `ctx.ai.buildHandler` (never raw keys).
 *
 * A trimmed sibling of live-memory's MemoryLlmClient: drain the handler's stream,
 * accumulate text + tool calls + usage, abort cooperatively between chunks. The plugin
 * sees the handler as an opaque value (`PluginAi<unknown>` keeps `@shofer/types`
 * browser-safe), so the slice used is declared structurally. One client per provider
 * profile — detector modes may carry their own profile, so the observer holds a small
 * cache keyed by profileRef.
 *
 * Caching note: the plugin controls PREFIX BYTES (append-only digest, identical
 * systemPrompt and message prefix across forks and passes); breakpoint placement is
 * the provider handler's own. Byte-stability is what earns the hits.
 */

import type { PluginAi } from "@shofer/types"

import { emptyUsage, type TokenUsage } from "./types.js"

export interface StreamChunk {
	type: string
	text?: string
	inputTokens?: number
	outputTokens?: number
	cacheReadTokens?: number
	cacheWriteTokens?: number
	totalCost?: number
	message?: string
	error?: string
	id?: string
	toolCallId?: string
	name?: string
	toolName?: string
	arguments?: string | Record<string, unknown>
	/** `tool_call_delta` argument fragment (ApiStreamToolCallDeltaChunk.delta). */
	delta?: string
	/** `tool_call_partial` stream position — the ONLY stable key across an
	 *  OpenAI-compatible provider's argument fragments (id/name usually ride
	 *  the first fragment alone). */
	index?: number
}

export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }

export interface ChatMessage {
	role: "user" | "assistant"
	content: string | ContentBlock[]
}

export interface ToolDefinition {
	type: "function"
	function: { name: string; description?: string; parameters?: Record<string, unknown> }
}

export interface ToolCallRequest {
	id: string
	name: string
	arguments: string
}

export interface ForkChatResult {
	text: string
	toolCalls: ToolCallRequest[]
	tokens: TokenUsage
	costUsd: number
}

interface HandlerModel {
	id: string
	info?: {
		contextWindow?: number
		inputPrice?: number
		outputPrice?: number
		/** Per-1M prices for cached tokens; Anthropic bills writes ~1.25x and reads ~0.1x. */
		cacheWritesPrice?: number
		cacheReadsPrice?: number
	}
}

interface ForkHandler {
	createMessage(
		systemPrompt: string,
		messages: ChatMessage[],
		metadata: { taskId: string; tools?: ToolDefinition[] },
	): AsyncIterable<StreamChunk>
	getModel?(): HandlerModel
}

/** Synthetic task id tagged onto observer requests (provider tracing). */
const OBSERVER_TASK_ID = "shofer-second-brain"

/** Conservative $/1M-token fallbacks when the handler reports no price. */
const FALLBACK_INPUT_PRICE = 1
const FALLBACK_OUTPUT_PRICE = 5

function normalizeArgs(args: string | Record<string, unknown> | undefined): string {
	return typeof args === "string" ? args : JSON.stringify(args ?? {})
}

/** The chat surface forks depend on — an interface so tests can script it. */
export interface ForkClient {
	chat(opts: {
		systemPrompt: string
		messages: ChatMessage[]
		tools: ToolDefinition[]
		signal?: AbortSignal
	}): Promise<ForkChatResult>
}

export class ForkLlmClient implements ForkClient {
	constructor(
		private readonly ai: PluginAi,
		private readonly profileRef?: string,
	) {}

	// Resolved PER CALL, never cached: an empty profileRef means "the host's
	// CURRENT default profile", which the user can repoint at any time — a
	// handler built once pinned the fork to whatever the default was when the
	// first pass ran, and a misconfigured build poisoned every later pass until
	// a plugin reload (both bit the Phase-0 live verification, TODO.md).
	// buildHandler is a local construction, so per-call resolution costs
	// nothing that matters; provider-side prefix caching keys on request BYTES,
	// not handler identity.
	private async getHandler(): Promise<ForkHandler> {
		return (await this.ai.buildHandler(this.profileRef || undefined)) as ForkHandler
	}

	async modelLabel(): Promise<string | undefined> {
		try {
			return (await this.getHandler()).getModel?.()?.id
		} catch {
			return undefined
		}
	}

	/** One provider round-trip: text + tool calls + usage; aborts between chunks. */
	async chat(opts: {
		systemPrompt: string
		messages: ChatMessage[]
		tools: ToolDefinition[]
		signal?: AbortSignal
	}): Promise<ForkChatResult> {
		const handler = await this.getHandler()

		let text = ""
		const tokens = emptyUsage()
		// Providers that price the call themselves report it; prefer that over our own
		// arithmetic, which cannot know every multiplier.
		let providerCost: number | undefined
		const toolCallsById = new Map<string, ToolCallRequest>()

		const stream = handler.createMessage(opts.systemPrompt, opts.messages, {
			taskId: OBSERVER_TASK_ID,
			tools: opts.tools,
		})

		for await (const chunk of stream) {
			if (opts.signal?.aborted) {
				const err = new Error("second-brain fork aborted")
				err.name = "AbortError"
				throw err
			}
			switch (chunk.type) {
				case "text":
					text += chunk.text ?? ""
					break
				case "usage":
					tokens.prompt += chunk.inputTokens ?? 0
					tokens.completion += chunk.outputTokens ?? 0
					tokens.cacheRead += chunk.cacheReadTokens ?? 0
					tokens.cacheWrite += chunk.cacheWriteTokens ?? 0
					if (typeof chunk.totalCost === "number") providerCost = (providerCost ?? 0) + chunk.totalCost
					break
				case "tool_call": {
					// A COMPLETE call in one chunk — replace wholesale.
					const id = chunk.id ?? chunk.toolCallId ?? `tc_${toolCallsById.size}`
					toolCallsById.set(id, {
						id,
						name: chunk.name ?? chunk.toolName ?? toolCallsById.get(id)?.name ?? "",
						arguments: normalizeArgs(chunk.arguments),
					})
					break
				}
				case "tool_call_partial": {
					// A raw OpenAI-compatible streaming delta: `index` is the only
					// stable key (id/name usually arrive on the FIRST fragment
					// only) and `arguments` is a FRAGMENT to APPEND — the same
					// semantics NativeToolCallParser.processRawChunk implements.
					// The previous id-keyed, replace-wholesale handling scattered
					// each fragment into its own nameless entry, so every fork's
					// feedback call came back with EMPTY arguments and coerced to
					// silent (TODO.md, Phase-0 blocker 3).
					const key = `idx_${chunk.index ?? 0}`
					const entry = toolCallsById.get(key) ?? { id: "", name: "", arguments: "" }
					if (chunk.id && !entry.id) entry.id = chunk.id
					if (!entry.name) entry.name = chunk.name ?? chunk.toolName ?? ""
					if (typeof chunk.arguments === "string") entry.arguments += chunk.arguments
					if (!entry.id) entry.id = key
					toolCallsById.set(key, entry)
					break
				}
				case "tool_call_start": {
					const id = chunk.id ?? chunk.toolCallId ?? `tc_${toolCallsById.size}`
					toolCallsById.set(id, { id, name: chunk.name ?? chunk.toolName ?? "", arguments: "" })
					break
				}
				case "tool_call_delta": {
					// ApiStreamToolCallDeltaChunk carries the fragment in `delta`
					// (the old code read `chunk.arguments`, which this chunk shape
					// never has — dropping every argument byte).
					const id = chunk.id ?? chunk.toolCallId
					if (id) {
						const entry = toolCallsById.get(id) ?? { id, name: chunk.name ?? "", arguments: "" }
						if (chunk.name && !entry.name) entry.name = chunk.name
						entry.arguments += chunk.delta ?? (typeof chunk.arguments === "string" ? chunk.arguments : "")
						toolCallsById.set(id, entry)
					}
					break
				}
				case "tool_call_end":
					break
				case "error":
					throw new Error(`second-brain LLM error: ${chunk.message ?? chunk.error ?? "unknown"}`)
				default:
					break
			}
		}

		let costUsd = providerCost ?? 0
		if (providerCost === undefined) {
			try {
				const info = handler.getModel?.()?.info
				const inPrice = info?.inputPrice ?? FALLBACK_INPUT_PRICE
				const outPrice = info?.outputPrice ?? FALLBACK_OUTPUT_PRICE
				// Cached tokens are NOT billed at the input rate: pricing them as if they
				// were would hide the very saving this design exists to produce.
				const writePrice = info?.cacheWritesPrice ?? inPrice * 1.25
				const readPrice = info?.cacheReadsPrice ?? inPrice * 0.1
				costUsd =
					(tokens.prompt * inPrice +
						tokens.completion * outPrice +
						tokens.cacheWrite * writePrice +
						tokens.cacheRead * readPrice) /
					1_000_000
			} catch {
				// Pricing is reporting, never gating.
			}
		}

		return {
			text,
			toolCalls: [...toolCallsById.values()].filter((c) => c.name),
			tokens,
			costUsd,
		}
	}
}
