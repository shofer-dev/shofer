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
	private handlerPromise?: Promise<ForkHandler>

	constructor(
		private readonly ai: PluginAi,
		private readonly profileRef?: string,
	) {}

	private async getHandler(): Promise<ForkHandler> {
		if (!this.handlerPromise) {
			this.handlerPromise = this.ai.buildHandler(this.profileRef || undefined) as Promise<ForkHandler>
		}
		return this.handlerPromise
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
				case "tool_call":
				case "tool_call_partial": {
					const id = chunk.id ?? chunk.toolCallId ?? `tc_${toolCallsById.size}`
					toolCallsById.set(id, {
						id,
						name: chunk.name ?? chunk.toolName ?? toolCallsById.get(id)?.name ?? "",
						arguments: normalizeArgs(chunk.arguments),
					})
					break
				}
				case "tool_call_start": {
					const id = chunk.id ?? chunk.toolCallId ?? `tc_${toolCallsById.size}`
					toolCallsById.set(id, { id, name: chunk.name ?? chunk.toolName ?? "", arguments: "" })
					break
				}
				case "tool_call_delta": {
					const id = chunk.id ?? chunk.toolCallId
					if (id) {
						const entry = toolCallsById.get(id) ?? { id, name: chunk.name ?? "", arguments: "" }
						if (chunk.name && !entry.name) entry.name = chunk.name
						entry.arguments += typeof chunk.arguments === "string" ? chunk.arguments : ""
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
