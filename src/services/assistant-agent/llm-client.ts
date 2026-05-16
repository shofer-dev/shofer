/**
 * AssistantAgentLlmClient — adapter that lets the Assistant Agent talk to LLMs
 * through the same `buildApiHandler` abstraction the main agent uses.
 *
 * Why this exists:
 *   The original implementation hand-rolled a per-provider `fetch` switch
 *   with hardcoded endpoints, body shapes, and response parsers. That
 *   duplicated dozens of provider quirks already solved by the main
 *   agent's `ApiHandler` hierarchy. This client maps the Assistant Agent's
 *   curated provider list onto `ProviderSettings` and consumes the
 *   resulting `ApiStream` non-streaming style: drain the generator,
 *   accumulate text chunks, capture the final usage chunk.
 *
 * Cancellation:
 *   `ApiHandler.createMessage` does not accept an AbortSignal, so we
 *   short-circuit the generator loop when the signal fires. The
 *   underlying HTTP request may still complete in the background; this
 *   is acceptable because assistant-agent cancellations are rare and the
 *   leaked response is bounded by the model's max output tokens.
 *
 * Pricing:
 *   Per-token cost is computed via `assistant-agent/pricing.ts`, which
 *   prefers the live model info reported by the underlying handler and
 *   falls back to a coarse table for providers that don't publish it.
 */

import type { Anthropic } from "@anthropic-ai/sdk"
import type OpenAI from "openai"

import type { AssistantAgentConfig } from "@shofer/types"

import { buildApiHandler, type ApiHandler } from "../../api"
import { estimateUsdCost } from "./pricing"
import { logger } from "../../utils/logging"

const LOG_PREFIX = "[AssistantAgent.LlmClient]"

/** Synthetic taskId used for `ApiHandlerCreateMessageMetadata`. */
const ASSISTANT_AGENT_TASK_ID = "shofer-assistant-agent"

export interface ChatMessage {
	role: "system" | "user" | "assistant"
	content: string
}

/** A single tool call surfaced by the model in this turn. */
export interface ToolCallRequest {
	id: string
	name: string
	/** Raw JSON string of arguments — parsed by the caller. */
	arguments: string
}

export interface ChatResult {
	/** Free-form text from the assistant; may be empty when only tool calls were emitted. */
	answer: string
	/** Concatenated reasoning/thinking output, if the model emitted any. */
	reasoning: string
	/** Tool calls the model wants the host to execute before continuing. */
	toolCalls: ToolCallRequest[]
	tokensUsed: {
		prompt: number
		completion: number
		total: number
	}
	estimatedCostUSD: number
}

/**
 * Streaming callback fired as the model emits chunks. Used by the agent
 * loop in `manager.ts` to mutate the in-flight assistant message in place
 * so the chat panel can render the turn live instead of waiting for the
 * whole reply.
 */
export type AgentStreamEvent =
	| { kind: "text"; delta: string }
	| { kind: "reasoning"; delta: string }
	/** Fired once per tool call, after the name + (best-effort) arguments are known. */
	| { kind: "tool_call"; toolCall: ToolCallRequest }

export type AgentStreamCallback = (event: AgentStreamEvent) => void

/**
 * Opts for the richer agent-loop variant of `chat()`. The system prompt is
 * passed separately (not as a leading message) so the agent loop can hold a
 * stable system prompt across iterations while the messages array grows.
 */
export interface AgentChatOptions {
	systemPrompt: string
	messages: Anthropic.Messages.MessageParam[]
	tools?: OpenAI.Chat.ChatCompletionTool[]
	signal?: AbortSignal
	/** Live stream callback; called between chunks. */
	onStream?: AgentStreamCallback
}

export class AssistantAgentLlmClient {
	private _handler: ApiHandler
	private _config: AssistantAgentConfig

	constructor(config: AssistantAgentConfig) {
		this._config = config
		this._handler = buildApiHandler(config.providerSettings, { taskId: ASSISTANT_AGENT_TASK_ID })
	}

	/**
	 * Issue a chat-completion request. System messages are concatenated
	 * (in order) into a single system prompt; user/assistant messages are
	 * forwarded as-is.
	 *
	 * The optional `signal` is checked between stream chunks; on abort the
	 * generator loop exits early.
	 */
	public async chat(messages: ChatMessage[], signal?: AbortSignal): Promise<ChatResult> {
		const { systemPrompt, conversation } = splitSystemAndConversation(messages)
		return this._runChat(systemPrompt, conversation, undefined, signal, undefined)
	}

	/**
	 * Agent-loop variant: caller manages the message array (including any
	 * tool_use / tool_result content blocks) and supplies the tool catalog.
	 * The result includes any tool calls the model wants executed.
	 */
	public async chatWithTools(opts: AgentChatOptions): Promise<ChatResult> {
		return this._runChat(opts.systemPrompt, opts.messages, opts.tools, opts.signal, opts.onStream)
	}

	private async _runChat(
		systemPrompt: string,
		conversation: Anthropic.Messages.MessageParam[],
		tools: OpenAI.Chat.ChatCompletionTool[] | undefined,
		signal: AbortSignal | undefined,
		onStream: AgentStreamCallback | undefined,
	): Promise<ChatResult> {
		const modelInfo = (() => {
			try {
				const m = this._handler.getModel()
				return `${m.id} ctx=${m.info?.contextWindow ?? "?"}`
			} catch (e) {
				return `(getModel failed: ${e instanceof Error ? e.message : String(e)})`
			}
		})()
		logger.info(
			`${LOG_PREFIX} chat() start provider=${this._config.providerSettings.apiProvider} model=${modelInfo} systemLen=${systemPrompt.length} convLen=${conversation.length} tools=${tools?.length ?? 0}`,
		)

		let answer = ""
		let reasoning = ""
		let promptTokens = 0
		let completionTokens = 0
		// Accumulator for tool calls emitted across stream chunks. Providers
		// either deliver a single complete `tool_call` chunk or stream the call
		// in pieces via tool_call_start / tool_call_delta / tool_call_end.
		const toolCallsById = new Map<string, { id: string; name: string; arguments: string }>()
		// Tracks which tool-call ids we've already announced via onStream so
		// each tool_call part lands in the UI exactly once.
		const streamedToolCallIds = new Set<string>()

		const emitToolCallIfReady = (id: string): void => {
			if (!onStream || streamedToolCallIds.has(id)) return
			const tc = toolCallsById.get(id)
			if (!tc || !tc.name) return
			streamedToolCallIds.add(id)
			onStream({ kind: "tool_call", toolCall: { ...tc } })
		}

		const startedAt = Date.now()
		let stream
		try {
			stream = this._handler.createMessage(systemPrompt, conversation, {
				taskId: ASSISTANT_AGENT_TASK_ID,
				tools,
			})
		} catch (e) {
			logger.error(
				`${LOG_PREFIX} chat() createMessage threw synchronously: ${e instanceof Error ? e.message : String(e)}\n${e instanceof Error ? (e.stack ?? "") : ""}`,
			)
			throw e
		}

		try {
			for await (const chunk of stream) {
				if (signal?.aborted) {
					logger.warn(`${LOG_PREFIX} chat() aborted via signal after ${Date.now() - startedAt}ms`)
					const err = new Error("Assistant agent LLM call aborted")
					err.name = "AbortError"
					throw err
				}

				switch (chunk.type) {
					case "text":
						answer += chunk.text
						if (onStream && chunk.text) onStream({ kind: "text", delta: chunk.text })
						break
					case "reasoning": {
						const c = chunk as any
						const text: string = typeof c.text === "string" ? c.text : ""
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
						const c = chunk as any
						const id = c.id ?? c.toolCallId ?? `tc_${toolCallsById.size}`
						toolCallsById.set(id, {
							id,
							name: c.name ?? c.toolName ?? "",
							arguments:
								typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}),
						})
						emitToolCallIfReady(id)
						break
					}
					case "tool_call_start": {
						const c = chunk as any
						const id = c.id ?? c.toolCallId ?? `tc_${toolCallsById.size}`
						toolCallsById.set(id, { id, name: c.name ?? c.toolName ?? "", arguments: "" })
						emitToolCallIfReady(id)
						break
					}
					case "tool_call_delta": {
						const c = chunk as any
						const id = c.id ?? c.toolCallId
						if (id) {
							const entry = toolCallsById.get(id) ?? { id, name: c.name ?? "", arguments: "" }
							if (c.name && !entry.name) entry.name = c.name
							entry.arguments += typeof c.arguments === "string" ? c.arguments : ""
							toolCallsById.set(id, entry)
							emitToolCallIfReady(id)
						}
						break
					}
					case "tool_call_partial": {
						// Some providers emit a single partial that grows; only the
						// final cumulative payload is meaningful, so overwrite.
						const c = chunk as any
						const id = c.id ?? c.toolCallId ?? `tc_${toolCallsById.size}`
						toolCallsById.set(id, {
							id,
							name: c.name ?? c.toolName ?? toolCallsById.get(id)?.name ?? "",
							arguments:
								typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}),
						})
						emitToolCallIfReady(id)
						break
					}
					case "tool_call_end": {
						const c = chunk as any
						const id = c.id ?? c.toolCallId
						if (id) emitToolCallIfReady(id)
						break
					}
					case "error":
						logger.error(
							`${LOG_PREFIX} chat() received error chunk: ${JSON.stringify({ message: (chunk as any).message, error: (chunk as any).error })}`,
						)
						throw new Error(`Assistant agent LLM error: ${chunk.message ?? chunk.error}`)
					default:
						break
				}
			}
		} catch (e) {
			logger.error(
				`${LOG_PREFIX} chat() stream FAILED after ${Date.now() - startedAt}ms answerLen=${answer.length} error=${e instanceof Error ? e.message : String(e)}\n${e instanceof Error ? (e.stack ?? "") : ""}`,
			)
			throw e
		}

		const totalTokens = promptTokens + completionTokens
		const estimatedCostUSD = estimateUsdCost(this._handler, promptTokens, completionTokens)
		const toolCalls = Array.from(toolCallsById.values()).filter((c) => c.name)

		logger.info(
			`${LOG_PREFIX} chat() done in ${Date.now() - startedAt}ms answerLen=${answer.length} toolCalls=${toolCalls.length} prompt=${promptTokens} completion=${completionTokens} cost=$${estimatedCostUSD.toFixed(6)}`,
		)

		return {
			answer,
			reasoning,
			toolCalls,
			tokensUsed: { prompt: promptTokens, completion: completionTokens, total: totalTokens },
			estimatedCostUSD,
		}
	}

	/** Underlying handler — exposed for diagnostics (e.g. model info). */
	public get handler(): ApiHandler {
		return this._handler
	}
}

/**
 * Concatenate adjacent system messages and convert user/assistant messages
 * to `Anthropic.Messages.MessageParam[]`. Assistant Agent messages are plain
 * strings, so the conversion is mechanical.
 */
function splitSystemAndConversation(messages: ChatMessage[]): {
	systemPrompt: string
	conversation: Anthropic.Messages.MessageParam[]
} {
	const systemParts: string[] = []
	const conversation: Anthropic.Messages.MessageParam[] = []

	for (const msg of messages) {
		if (msg.role === "system") {
			systemParts.push(msg.content)
			continue
		}
		conversation.push({ role: msg.role as "user" | "assistant", content: msg.content })
	}

	return { systemPrompt: systemParts.join("\n\n"), conversation }
}
