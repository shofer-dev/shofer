/**
 * memory-llm — the plugin's LLM adapter, built on `ctx.ai` (the P6.G1 host-LLM
 * capability). It is the plugin-native analogue of the built-in Live Memory's
 * `LiveMemoryLlmClient`: it obtains the *same* `ApiHandler` the main agent uses via
 * `ctx.ai.buildHandler(profileRef)` (never raw API keys) and consumes its stream
 * non-streaming style — drain the async generator, accumulate text/reasoning/tool
 * calls, capture usage.
 *
 * The plugin sees the handler only as an opaque value (`PluginAi<unknown>` keeps
 * `@shofer/types` browser-safe), so we describe the slice of the handler surface we
 * actually use with minimal structural types and cast to them. {@link MemoryLlmClient}
 * ports `LiveMemoryLlmClient._runChat` **including** its per-provider tool-call chunk
 * accumulator (the 6 chunk shapes) so the Stage-C agent loop can drive a real
 * tool-using conversation; the standalone {@link answerFromMemory}/{@link summarizeMemory}
 * helpers remain for the single-turn summarize-over-memory paths (the maintenance
 * service).
 */

import type { PluginAi } from "@shofer/types"

import type { MemoryData } from "./memory-store.js"
import { estimateUsdCost, type PricingHandler } from "./pricing.js"

/** Synthetic task id tagged onto the memory LLM's requests (provider tracing). */
const MEMORY_TASK_ID = "shofer-live-memory-plugin"

/**
 * The minimal slice of an `ApiHandler` stream chunk this adapter consumes. Providers
 * emit heterogeneous chunk shapes for tool calls (see {@link MemoryLlmClient.chatWithTools}),
 * so the tool-call fields are broadly optional and read defensively.
 */
interface StreamChunk {
	type: string
	text?: string
	inputTokens?: number
	outputTokens?: number
	message?: string
	error?: string
	// ── tool-call chunk fields (shapes vary by provider) ──
	id?: string
	toolCallId?: string
	name?: string
	toolName?: string
	arguments?: string | Record<string, unknown>
}
interface MinimalMessage {
	role: "user" | "assistant"
	content: string
}

/** Model info slice read for pricing + the context-window/section labels. */
interface HandlerModel {
	id: string
	info?: { contextWindow?: number; inputPrice?: number; outputPrice?: number }
}

interface MinimalHandler {
	createMessage(
		systemPrompt: string,
		messages: MinimalMessage[],
		metadata: { taskId: string },
	): AsyncIterable<StreamChunk>
	getModel?(): HandlerModel
}

// ─── Agent-loop (tool-using) surface — ported from llm-client.ts ────────────────

/** A single tool call the model surfaced in a turn. `arguments` is a raw JSON string. */
export interface ToolCallRequest {
	id: string
	name: string
	arguments: string
}

/** OpenAI-style tool definition (structural mirror of `OpenAI.Chat.ChatCompletionTool`). */
export interface ToolDefinition {
	type: "function"
	function: {
		name: string
		description?: string
		parameters?: Record<string, unknown>
	}
}

/**
 * A conversation message param (structural mirror of `Anthropic.Messages.MessageParam`).
 * `content` is either flat text or an array of content blocks (text / tool_use /
 * tool_result) so the agent loop can carry tool round-trips. Shapes match the built-in
 * exactly so the identical runtime `ApiHandler` accepts them.
 */
export type ConversationContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }

export interface ConversationMessage {
	role: "user" | "assistant"
	content: string | ConversationContentBlock[]
}

/** Result of one `chatWithTools` turn. */
export interface ChatResult {
	/** Free-form assistant text; may be empty when only tool calls were emitted. */
	answer: string
	/** Concatenated reasoning/thinking output, if any. */
	reasoning: string
	/** Tool calls the model wants executed before continuing. */
	toolCalls: ToolCallRequest[]
	tokensUsed: { prompt: number; completion: number; total: number }
	estimatedCostUSD: number
}

/** Streaming callback fired as the model emits chunks (consumed by the Stage-C loop / Stage-E UI). */
export type AgentStreamEvent =
	| { kind: "text"; delta: string }
	| { kind: "reasoning"; delta: string }
	| { kind: "tool_call"; toolCall: ToolCallRequest }
export type AgentStreamCallback = (event: AgentStreamEvent) => void

/** Opts for the agent-loop variant of `chat()`. System prompt is passed separately. */
export interface AgentChatOptions {
	systemPrompt: string
	messages: ConversationMessage[]
	tools?: ToolDefinition[]
	signal?: AbortSignal
	onStream?: AgentStreamCallback
}

/** The tool-using handler slice (adds `tools` to metadata + returns the tool-chunk stream). */
interface ToolChatHandler {
	createMessage(
		systemPrompt: string,
		messages: ConversationMessage[],
		metadata: { taskId: string; tools?: ToolDefinition[] },
	): AsyncIterable<StreamChunk>
	getModel?(): HandlerModel
}

export interface MemoryAnswer {
	answer: string
	promptTokens: number
	completionTokens: number
	/** The underlying model id, when the handler exposes it (for the section/UI). */
	modelId?: string
}

/**
 * MemoryLlmClient — the plugin-native `LiveMemoryLlmClient`. Wraps a single host
 * `ApiHandler` (built once, lazily, via `ctx.ai.buildHandler`) and exposes the
 * agent-loop `chatWithTools` used by {@link LiveMemoryAgent}. Cancellation is by
 * short-circuiting the generator on `signal.aborted` (the underlying HTTP request may
 * still complete in the background — bounded by max output tokens, exactly like the
 * built-in). Cost is computed via {@link estimateUsdCost} over the *same* handler.
 */
export class MemoryLlmClient {
	private handlerPromise?: Promise<ToolChatHandler>
	private cachedModel?: HandlerModel

	constructor(
		private readonly ai: PluginAi,
		private readonly profileRef?: string,
	) {}

	/** Build the host handler once (throws on the denying stub — surfaced to the caller). */
	private async getHandler(): Promise<ToolChatHandler> {
		if (!this.handlerPromise) {
			this.handlerPromise = this.ai.buildHandler(this.profileRef || undefined) as Promise<ToolChatHandler>
		}
		return this.handlerPromise
	}

	/** Best-effort model info (id + context window + prices), cached after first read. */
	async getModelInfo(): Promise<HandlerModel | undefined> {
		if (this.cachedModel) return this.cachedModel
		try {
			const handler = await this.getHandler()
			this.cachedModel = handler.getModel?.()
		} catch {
			// buildHandler / getModel unavailable — caller falls back to defaults.
		}
		return this.cachedModel
	}

	/**
	 * Agent-loop variant of `chat()`: the caller manages the message array (including
	 * any tool_use / tool_result blocks) and supplies the tool catalog. The result
	 * includes any tool calls the model wants executed. Ports `LiveMemoryLlmClient._runChat`
	 * verbatim — including the 6-shape tool-call chunk accumulator.
	 */
	async chatWithTools(opts: AgentChatOptions): Promise<ChatResult> {
		const handler = await this.getHandler()

		let answer = ""
		let reasoning = ""
		let promptTokens = 0
		let completionTokens = 0

		// Accumulator for tool calls emitted across stream chunks. Providers either
		// deliver a single complete `tool_call` chunk or stream the call in pieces via
		// tool_call_start / tool_call_delta / tool_call_partial / tool_call_end.
		const toolCallsById = new Map<string, { id: string; name: string; arguments: string }>()
		// Tracks which ids we've already announced via onStream so each tool_call part
		// lands in the UI exactly once.
		const streamedToolCallIds = new Set<string>()

		const onStream = opts.onStream
		const emitToolCallIfReady = (id: string): void => {
			if (!onStream || streamedToolCallIds.has(id)) return
			const tc = toolCallsById.get(id)
			if (!tc || !tc.name) return
			streamedToolCallIds.add(id)
			onStream({ kind: "tool_call", toolCall: { ...tc } })
		}

		const stream = handler.createMessage(opts.systemPrompt, opts.messages, {
			taskId: MEMORY_TASK_ID,
			tools: opts.tools,
		})

		for await (const chunk of stream) {
			if (opts.signal?.aborted) {
				const err = new Error("Live Memory LLM call aborted")
				err.name = "AbortError"
				throw err
			}

			switch (chunk.type) {
				case "text":
					answer += chunk.text ?? ""
					if (onStream && chunk.text) onStream({ kind: "text", delta: chunk.text })
					break
				case "reasoning": {
					const text = typeof chunk.text === "string" ? chunk.text : ""
					if (text) {
						reasoning += text
						if (onStream) onStream({ kind: "reasoning", delta: text })
					}
					break
				}
				case "usage":
					promptTokens += chunk.inputTokens ?? 0
					completionTokens += chunk.outputTokens ?? 0
					break
				case "tool_call": {
					const id = chunk.id ?? chunk.toolCallId ?? `tc_${toolCallsById.size}`
					toolCallsById.set(id, {
						id,
						name: chunk.name ?? chunk.toolName ?? "",
						arguments: normalizeArgs(chunk.arguments),
					})
					emitToolCallIfReady(id)
					break
				}
				case "tool_call_start": {
					const id = chunk.id ?? chunk.toolCallId ?? `tc_${toolCallsById.size}`
					toolCallsById.set(id, { id, name: chunk.name ?? chunk.toolName ?? "", arguments: "" })
					emitToolCallIfReady(id)
					break
				}
				case "tool_call_delta": {
					const id = chunk.id ?? chunk.toolCallId
					if (id) {
						const entry = toolCallsById.get(id) ?? { id, name: chunk.name ?? "", arguments: "" }
						if (chunk.name && !entry.name) entry.name = chunk.name
						entry.arguments += typeof chunk.arguments === "string" ? chunk.arguments : ""
						toolCallsById.set(id, entry)
						emitToolCallIfReady(id)
					}
					break
				}
				case "tool_call_partial": {
					// Some providers emit a single partial that grows; only the final
					// cumulative payload is meaningful, so overwrite.
					const id = chunk.id ?? chunk.toolCallId ?? `tc_${toolCallsById.size}`
					toolCallsById.set(id, {
						id,
						name: chunk.name ?? chunk.toolName ?? toolCallsById.get(id)?.name ?? "",
						arguments: normalizeArgs(chunk.arguments),
					})
					emitToolCallIfReady(id)
					break
				}
				case "tool_call_end": {
					const id = chunk.id ?? chunk.toolCallId
					if (id) emitToolCallIfReady(id)
					break
				}
				case "error":
					throw new Error(`Live Memory LLM error: ${chunk.message ?? chunk.error ?? "unknown"}`)
				default:
					break
			}
		}

		const totalTokens = promptTokens + completionTokens
		const estimatedCostUSD = estimateUsdCost(handler as unknown as PricingHandler, promptTokens, completionTokens)
		const toolCalls = Array.from(toolCallsById.values()).filter((c) => c.name)

		return {
			answer,
			reasoning,
			toolCalls,
			tokensUsed: { prompt: promptTokens, completion: completionTokens, total: totalTokens },
			estimatedCostUSD,
		}
	}
}

/** Coerce a tool-call `arguments` chunk field to a raw JSON string. */
function normalizeArgs(args: string | Record<string, unknown> | undefined): string {
	return typeof args === "string" ? args : JSON.stringify(args ?? {})
}

/**
 * Render the accumulated memory into a compact context block the LLM reasons over.
 * Newest activity last so the model weights recent edits; Q&A history is included so
 * the memory behaves as a persistent companion across tasks.
 */
export function renderMemoryContext(data: MemoryData, maxObservations = 120): string {
	const lines: string[] = []
	if (data.stats.summary) {
		lines.push("## Running summary", data.stats.summary, "")
	}
	const recent = data.observations.slice(-maxObservations)
	if (recent.length > 0) {
		lines.push("## Recent activity (oldest → newest)")
		for (const o of recent) {
			const when = new Date(o.at).toISOString()
			const via = o.via ? ` via ${o.via}` : ""
			const note = o.note ? ` — ${o.note}` : ""
			lines.push(`- [${when}] ${o.kind}: ${o.subject}${via}${note}`)
		}
		lines.push("")
	}
	if (data.qa.length > 0) {
		lines.push("## Earlier questions answered")
		for (const qa of data.qa.slice(-10)) {
			lines.push(`Q: ${qa.question}`, `A: ${qa.answer}`, "")
		}
	}
	if (lines.length === 0) {
		lines.push("(No activity has been observed in this workspace yet.)")
	}
	return lines.join("\n")
}

const SYSTEM_PREAMBLE = `You are Shofer's Live Memory — a persistent, read-only companion that has accumulated a log of activity in a software workspace (files Shofer edited and read, external changes, and prior Q&A).

Answer the user's question using ONLY the accumulated memory below. Be concise and concrete: cite the specific files/observations that ground your answer. If the memory does not contain enough information to answer, say so plainly and suggest what to inspect — do not invent details.`

/**
 * Answer `question` from the accumulated `memory` using `ctx.ai`. Builds the host
 * handler (throws loudly if the plugin is granted `permissions.ai` but not
 * AI-consented — the denying stub), then drains the stream. `profileRef` selects the
 * provider profile (host default when empty).
 */
export async function answerFromMemory(
	ai: PluginAi,
	profileRef: string | undefined,
	question: string,
	memory: MemoryData,
	opts: { maxAnswerChars?: number } = {},
): Promise<MemoryAnswer> {
	const handler = (await ai.buildHandler(profileRef || undefined)) as MinimalHandler

	const context = renderMemoryContext(memory)
	const budget =
		opts.maxAnswerChars && opts.maxAnswerChars > 0
			? `\n\nKeep your answer under ~${opts.maxAnswerChars} characters.`
			: ""
	const systemPrompt = `${SYSTEM_PREAMBLE}${budget}\n\n==== ACCUMULATED MEMORY ====\n${context}`

	let answer = ""
	let promptTokens = 0
	let completionTokens = 0

	const stream = handler.createMessage(systemPrompt, [{ role: "user", content: question }], {
		taskId: MEMORY_TASK_ID,
	})
	for await (const chunk of stream) {
		switch (chunk.type) {
			case "text":
				answer += chunk.text ?? ""
				break
			case "usage":
				promptTokens += chunk.inputTokens ?? 0
				completionTokens += chunk.outputTokens ?? 0
				break
			case "error":
				throw new Error(`Live Memory LLM error: ${chunk.message ?? chunk.error ?? "unknown"}`)
			default:
				break
		}
	}

	let modelId: string | undefined
	try {
		modelId = handler.getModel?.().id
	} catch {
		// getModel is best-effort; absence is fine.
	}

	return { answer: answer.trim(), promptTokens, completionTokens, modelId }
}

/**
 * Compact the observation log into a short running summary via `ctx.ai` (used by the
 * background maintenance service). Returns the summary text, or `undefined` when
 * there is nothing worth summarizing.
 */
export async function summarizeMemory(
	ai: PluginAi,
	profileRef: string | undefined,
	memory: MemoryData,
): Promise<string | undefined> {
	if (memory.observations.length === 0) return undefined
	const handler = (await ai.buildHandler(profileRef || undefined)) as MinimalHandler
	const systemPrompt =
		"Summarize the following workspace activity log into a compact, durable set of notes about what parts of the codebase are being worked on and how. Prefer file/area names and relationships. Keep it under 1500 characters."
	const context = renderMemoryContext(memory, 400)

	let summary = ""
	const stream = handler.createMessage(systemPrompt, [{ role: "user", content: context }], {
		taskId: MEMORY_TASK_ID,
	})
	for await (const chunk of stream) {
		if (chunk.type === "text") summary += chunk.text ?? ""
		else if (chunk.type === "error") throw new Error(`Live Memory summarize error: ${chunk.message ?? chunk.error}`)
	}
	return summary.trim() || undefined
}
