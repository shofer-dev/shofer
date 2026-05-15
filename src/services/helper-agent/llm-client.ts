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

import type { HelperAgentConfig, HelperAgentProvider } from "@shofer/types"
import type { ProviderSettings, ProviderName } from "@shofer/types"

import { buildApiHandler, type ApiHandler } from "../../api"
import { logger } from "../../utils/logging"
import { estimateUsdCost } from "./pricing"

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
		this._handler = buildApiHandler(toProviderSettings(config), { taskId: HELPER_AGENT_TASK_ID })
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

		let answer = ""
		let promptTokens = 0
		let completionTokens = 0

		const stream = this._handler.createMessage(systemPrompt, conversation, { taskId: HELPER_AGENT_TASK_ID })

		for await (const chunk of stream) {
			if (signal?.aborted) {
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
					throw new Error(`Helper agent LLM error: ${chunk.message ?? chunk.error}`)
				default:
					// reasoning / tool_call / grounding chunks are not used by
					// the helper agent (it is a chat-only Q&A surface).
					break
			}
		}

		const totalTokens = promptTokens + completionTokens
		const estimatedCostUSD = estimateUsdCost(this._handler, promptTokens, completionTokens)

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

/**
 * Map the Helper Agent's curated provider list to a `ProviderSettings`
 * record understood by `buildApiHandler`. The Helper Agent intentionally
 * exposes a small subset of providers; this is the single place that
 * knows how to translate them.
 */
function toProviderSettings(config: HelperAgentConfig): ProviderSettings {
	const { provider, modelId, apiKey, baseUrl } = config

	const apiProvider = mapProvider(provider)

	switch (apiProvider) {
		case "openai":
			return {
				apiProvider,
				openAiApiKey: apiKey,
				openAiBaseUrl: baseUrl,
				openAiModelId: modelId,
				openAiStreamingEnabled: true,
			}
		case "gemini":
			return {
				apiProvider,
				geminiApiKey: apiKey,
				googleGeminiBaseUrl: baseUrl,
				apiModelId: modelId,
			}
		case "anthropic":
			return {
				apiProvider,
				apiKey,
				anthropicBaseUrl: baseUrl,
				apiModelId: modelId,
			}
		case "ollama":
			return {
				apiProvider,
				ollamaApiKey: apiKey,
				ollamaBaseUrl: baseUrl,
				ollamaModelId: modelId,
			}
		case "openrouter":
			return {
				apiProvider,
				openRouterApiKey: apiKey,
				openRouterModelId: modelId,
			}
		default: {
			// Should be unreachable; mapProvider only returns the cases above.
			logger.warn(`[HelperAgent.LlmClient] Unhandled provider mapping: ${apiProvider}`)
			return { apiProvider }
		}
	}
}

function mapProvider(provider: HelperAgentProvider): ProviderName {
	switch (provider) {
		case "openai":
		case "openai-compatible":
			return "openai"
		case "gemini":
			return "gemini"
		case "anthropic":
			return "anthropic"
		case "ollama":
			return "ollama"
		case "openrouter":
			return "openrouter"
	}
}
