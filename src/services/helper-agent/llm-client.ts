/**
 * HelperAgentLlmClient — adapter that lets the Helper Agent talk to LLMs
 * through the same `buildApiHandler` abstraction the main agent uses.
 *
 * Why this exists:
 *   The original implementation hand-rolled a per-provider `fetch` switch
 *   with hardcoded endpoints, body shapes, and response parsers. That
 *   duplicated dozens of provider quirks already solved by the main
 *   agent's `ApiHandler` hierarchy. This client maps the Helper Agent's
 *   curated provider list onto `ProviderSettings` and consumes the
 *   resulting `ApiStream` non-streaming style: drain the generator,
 *   accumulate text chunks, capture the final usage chunk.
 *
 * Cancellation:
 *   `ApiHandler.createMessage` does not accept an AbortSignal, so we
 *   short-circuit the generator loop when the signal fires. The
 *   underlying HTTP request may still complete in the background; this
 *   is acceptable because helper-agent cancellations are rare and the
 *   leaked response is bounded by the model's max output tokens.
 *
 * Pricing:
 *   Per-token cost is computed via `helper-agent/pricing.ts`, which
 *   prefers the live model info reported by the underlying handler and
 *   falls back to a coarse table for providers that don't publish it.
 */

import type { Anthropic } from "@anthropic-ai/sdk"

import type { HelperAgentConfig } from "@shofer/types"

import { buildApiHandler, type ApiHandler } from "../../api"
import { estimateUsdCost } from "./pricing"
import { logger } from "../../utils/logging"

const LOG_PREFIX = "[HelperAgent.LlmClient]"

/** Synthetic taskId used for `ApiHandlerCreateMessageMetadata`. */
const HELPER_AGENT_TASK_ID = "shofer-helper-agent"

export interface ChatMessage {
	role: "system" | "user" | "assistant"
	content: string
}

export interface ChatResult {
	answer: string
	tokensUsed: {
		prompt: number
		completion: number
		total: number
	}
	estimatedCostUSD: number
}

export class HelperAgentLlmClient {
	private _handler: ApiHandler
	private _config: HelperAgentConfig

	constructor(config: HelperAgentConfig) {
		this._config = config
		this._handler = buildApiHandler(config.providerSettings, { taskId: HELPER_AGENT_TASK_ID })
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

		const modelInfo = (() => {
			try {
				const m = this._handler.getModel()
				return `${m.id} ctx=${m.info?.contextWindow ?? "?"}`
			} catch (e) {
				return `(getModel failed: ${e instanceof Error ? e.message : String(e)})`
			}
		})()
		logger.info(
			`${LOG_PREFIX} chat() start provider=${this._config.providerSettings.apiProvider} model=${modelInfo} systemLen=${systemPrompt.length} convLen=${conversation.length}`,
		)

		let answer = ""
		let promptTokens = 0
		let completionTokens = 0

		const startedAt = Date.now()
		let stream
		try {
			stream = this._handler.createMessage(systemPrompt, conversation, { taskId: HELPER_AGENT_TASK_ID })
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
					const err = new Error("Helper agent LLM call aborted")
					err.name = "AbortError"
					throw err
				}

				switch (chunk.type) {
					case "text":
						answer += chunk.text
						break
					case "usage":
						promptTokens += chunk.inputTokens ?? 0
						completionTokens += chunk.outputTokens ?? 0
						break
					case "error":
						logger.error(
							`${LOG_PREFIX} chat() received error chunk: ${JSON.stringify({ message: (chunk as any).message, error: (chunk as any).error })}`,
						)
						throw new Error(`Helper agent LLM error: ${chunk.message ?? chunk.error}`)
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

		logger.info(
			`${LOG_PREFIX} chat() done in ${Date.now() - startedAt}ms answerLen=${answer.length} prompt=${promptTokens} completion=${completionTokens} cost=$${estimatedCostUSD.toFixed(6)}`,
		)

		return {
			answer,
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
 * to `Anthropic.Messages.MessageParam[]`. Helper Agent messages are plain
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
		conversation.push({ role: msg.role, content: msg.content })
	}

	return { systemPrompt: systemParts.join("\n\n"), conversation }
}
