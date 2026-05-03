import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"
import OpenAI from "openai"
import { v7 as uuidv7 } from "uuid"

import { type ModelInfo, openAiModelInfoSaneDefaults } from "@roo-code/types"

import type { ApiHandlerOptions } from "../../shared/api"
import { SELECTOR_SEPARATOR, stringifyVsCodeLmModelSelector } from "../../shared/vsCodeSelectorUtils"
import { normalizeToolSchema } from "../../utils/json-schema"
import { getOutputChannel } from "../../extension"

import { ApiStream } from "../transform/stream"
import { convertToVsCodeLmMessages, extractTextCountFromMessage } from "../transform/vscode-lm-format"

import { BaseProvider } from "./base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"

/**
 * Converts OpenAI-format tools to VSCode Language Model tools.
 * Normalizes the JSON Schema to draft 2020-12 compliant format required by
 * GitHub Copilot's backend, converting type: ["T", "null"] to anyOf format.
 * @param tools Array of OpenAI ChatCompletionTool definitions
 * @returns Array of VSCode LanguageModelChatTool definitions
 */
function convertToVsCodeLmTools(tools: OpenAI.Chat.ChatCompletionTool[]): vscode.LanguageModelChatTool[] {
	return tools
		.filter((tool) => tool.type === "function")
		.map((tool) => ({
			name: tool.function.name,
			description: tool.function.description || "",
			inputSchema: tool.function.parameters
				? normalizeToolSchema(tool.function.parameters as Record<string, unknown>)
				: undefined,
		}))
}

/**
 * Handles interaction with VS Code's Language Model API for chat-based operations.
 * This handler extends BaseProvider to provide VS Code LM specific functionality.
 *
 * @extends {BaseProvider}
 *
 * @remarks
 * The handler manages a VS Code language model chat client and provides methods to:
 * - Create and manage chat client instances
 * - Stream messages using VS Code's Language Model API
 * - Retrieve model information
 *
 * @example
 * ```typescript
 * const options = {
 *   vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-4" }
 * };
 * const handler = new VsCodeLmHandler(options);
 *
 * // Stream a conversation
 * const systemPrompt = "You are a helpful assistant";
 * const messages = [{ role: "user", content: "Hello!" }];
 * for await (const chunk of handler.createMessage(systemPrompt, messages)) {
 *   console.log(chunk);
 * }
 * ```
 */
export class VsCodeLmHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private client: vscode.LanguageModelChat | null
	private disposable: vscode.Disposable | null
	private currentRequestCancellation: vscode.CancellationTokenSource | null
	private conversationId: string
	private parentConversationId: string | undefined
	private rootConversationId: string | undefined
	/**
	 * Pricing in USD per 1M tokens for the currently selected model, when
	 * known. Populated asynchronously after `initializeClient` by querying
	 * the well-known `arkware.llm.getModelPricing` command exposed by the
	 * Arkware LLM Model Provider extension. The VS Code LM Chat API itself
	 * carries no pricing fields, so without this side channel `getModel()`
	 * would have to keep returning `inputPrice: 0`/`outputPrice: 0`, which
	 * makes Roo's downstream `calculateApiCostOpenAI` produce `0` and the
	 * task header's `apiCost` row never render. Stays `undefined` for
	 * non-arkware vendors, in which case behaviour is unchanged.
	 */
	private arkwarePricing:
		| {
				inputPrice: number
				outputPrice: number
				cacheReadsPrice?: number
				cacheWritesPrice?: number
		  }
		| undefined

	/**
	 * Capability flags for the active client's model, fetched from the
	 * Arkware LLM Model Provider extension via the well-known
	 * `arkware.llm.getModelCapabilities` command. The VS Code LM Chat API's
	 * `LanguageModelChatProviderCapabilities` only models `imageInput` and
	 * `toolCalling`, with no slot for prompt-cache support — and even those
	 * two we prefer to source from llm-router's registry rather than rely on
	 * VS Code's own capability surface, which is the single source of truth
	 * for model capabilities across the stack. Stays `undefined` until the
	 * async refresh completes or for non-arkware vendors.
	 */
	private arkwareCapabilities:
		| {
				imageInput: boolean
				toolCalling: boolean
				promptCache: boolean
		  }
		| undefined

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		this.client = null
		this.disposable = null
		this.currentRequestCancellation = null
		// Use taskId from options if provided, otherwise generate a fallback UUID
		this.conversationId = options.taskId ?? uuidv7()
		this.parentConversationId = options.parentTaskId
		this.rootConversationId = options.rootTaskId
		console.log(
			`[DEEPSEEK-DIAG] VsCodeLmHandler created: conversationId=${this.conversationId}, taskId=${options.taskId}, parentTaskId=${options.parentTaskId}, rootTaskId=${options.rootTaskId}`,
		)

		try {
			// Listen for model changes and reset client
			this.disposable = vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration("lm")) {
					try {
						this.client = null
						this.ensureCleanState()
					} catch (error) {
						console.error("Error during configuration change cleanup:", error)
					}
				}
			})
			this.initializeClient()
		} catch (error) {
			// Ensure cleanup if constructor fails
			this.dispose()

			throw new Error(
				`Roo Code <Language Model API>: Failed to initialize handler: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
		}
	}
	/**
	 * Initializes the VS Code Language Model client.
	 * This method is called during the constructor to set up the client.
	 * This useful when the client is not created yet and call getModel() before the client is created.
	 * @returns Promise<void>
	 * @throws Error when client initialization fails
	 */
	async initializeClient(): Promise<void> {
		try {
			// Check if the client is already initialized
			if (this.client) {
				console.debug("Roo Code <Language Model API>: Client already initialized")
				return
			}
			// Create a new client instance
			this.client = await this.createClient(this.options.vsCodeLmModelSelector || {})
			console.debug("Roo Code <Language Model API>: Client initialized successfully")
			// Best-effort prefetch of pricing and capabilities for the selected
			// model. Failures are non-fatal: non-arkware setups simply leave
			// these unset (consumers fall back to conservative defaults).
			void this.refreshArkwarePricing()
			void this.refreshArkwareCapabilities()
		} catch (error) {
			// Handle errors during client initialization
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			console.error("Roo Code <Language Model API>: Client initialization failed:", errorMessage)
			throw new Error(`Roo Code <Language Model API>: Failed to initialize client: ${errorMessage}`)
		}
	}

	/**
	 * Look up pricing for the active client's model via the Arkware LLM
	 * Model Provider extension's well-known command. Tries the bare model id
	 * first and falls back to the slash-free `family` identifier so the
	 * provider can resolve either form. Sets `this.arkwarePricing` on
	 * success; silently leaves it untouched on miss/failure.
	 */
	private async refreshArkwarePricing(): Promise<void> {
		if (!this.client) return
		const candidates = [this.client.id, this.client.family].filter(
			(s): s is string => typeof s === "string" && s.length > 0,
		)
		for (const candidate of candidates) {
			try {
				const pricing = await vscode.commands.executeCommand<
					| { inputPrice: number; outputPrice: number; cacheReadsPrice?: number; cacheWritesPrice?: number }
					| undefined
				>("arkware.llm.getModelPricing", candidate)
				if (pricing && (pricing.inputPrice > 0 || pricing.outputPrice > 0)) {
					this.arkwarePricing = pricing
					return
				}
			} catch {
				// Command not registered (no arkware extension) or threw — try next.
			}
		}
	}

	/**
	 * Look up capability flags for the active client's model via the
	 * Arkware LLM Model Provider extension's well-known
	 * `arkware.llm.getModelCapabilities` command. Mirrors
	 * {@link refreshArkwarePricing} in identifier-resolution strategy. Sets
	 * `this.arkwareCapabilities` on success; silently leaves it untouched on
	 * miss/failure (e.g. when the arkware extension isn't installed).
	 */
	private async refreshArkwareCapabilities(): Promise<void> {
		if (!this.client) return
		const candidates = [this.client.id, this.client.family].filter(
			(s): s is string => typeof s === "string" && s.length > 0,
		)
		for (const candidate of candidates) {
			try {
				const caps = await vscode.commands.executeCommand<
					{ imageInput: boolean; toolCalling: boolean; promptCache: boolean } | undefined
				>("arkware.llm.getModelCapabilities", candidate)
				if (caps) {
					this.arkwareCapabilities = caps
					return
				}
			} catch {
				// Command not registered (no arkware extension) or threw — try next.
			}
		}
	}

	/**
	 * Pull the running USD cost for `this.conversationId` from the Arkware
	 * LLM Model Provider extension via the well-known
	 * `arkware.llm.getRequestCost` command. Returns `undefined` when the
	 * command isn't registered (no arkware extension), when the provider
	 * has no cost data for this conversation (e.g. no completion has
	 * routed through a model whose pricing the router can compute), or on
	 * any error. Caller should treat `undefined` as "fall back to
	 * per-token math".
	 *
	 * This is the canonical cost source for composite (`arkware/*`)
	 * models, where the underlying serving model is picked at request
	 * time and `getModel().info.inputPrice` is therefore zero — making
	 * Roo's downstream `calculateApiCostOpenAI` produce $0 and the cost
	 * row never render.
	 */
	private async fetchArkwareRequestCost(): Promise<number | undefined> {
		if (!this.conversationId) return undefined
		try {
			const cost = await vscode.commands.executeCommand<number | undefined>(
				"arkware.llm.getRequestCost",
				this.conversationId,
			)
			if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
				return cost
			}
			return undefined
		} catch {
			return undefined
		}
	}
	/**
	 * Creates a language model chat client based on the provided selector.
	 *
	 * @param selector - Selector criteria to filter language model chat instances
	 * @returns Promise resolving to the first matching language model chat instance
	 * @throws Error when no matching models are found with the given selector
	 *
	 * @example
	 * const selector = { vendor: "copilot", family: "gpt-4o" };
	 * const chatClient = await createClient(selector);
	 */
	async createClient(selector: vscode.LanguageModelChatSelector): Promise<vscode.LanguageModelChat> {
		try {
			const models = await vscode.lm.selectChatModels(selector)

			// Use first available model or create a minimal model object
			if (models && Array.isArray(models) && models.length > 0) {
				return models[0]
			}

			// Create a minimal model if no models are available
			return {
				id: "default-lm",
				name: "Default Language Model",
				vendor: "vscode",
				family: "lm",
				version: "1.0",
				maxInputTokens: 8192,
				sendRequest: async (_messages, _options, _token) => {
					// Provide a minimal implementation
					return {
						stream: (async function* () {
							yield new vscode.LanguageModelTextPart(
								"Language model functionality is limited. Please check VS Code configuration.",
							)
						})(),
						text: (async function* () {
							yield "Language model functionality is limited. Please check VS Code configuration."
						})(),
					}
				},
				countTokens: async () => 0,
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			throw new Error(`Roo Code <Language Model API>: Failed to select model: ${errorMessage}`)
		}
	}

	/**
	 * Creates and streams a message using the VS Code Language Model API.
	 *
	 * @param systemPrompt - The system prompt to initialize the conversation context
	 * @param messages - An array of message parameters following the Anthropic message format
	 * @param metadata - Optional metadata for the message
	 *
	 * @yields {ApiStream} An async generator that yields either text chunks or tool calls from the model response
	 *
	 * @throws {Error} When vsCodeLmModelSelector option is not provided
	 * @throws {Error} When the response stream encounters an error
	 *
	 * @remarks
	 * This method handles the initialization of the VS Code LM client if not already created,
	 * converts the messages to VS Code LM format, and streams the response chunks.
	 * Tool calls handling is currently a work in progress.
	 */
	dispose(): void {
		if (this.disposable) {
			this.disposable.dispose()
		}

		if (this.currentRequestCancellation) {
			this.currentRequestCancellation.cancel()
			this.currentRequestCancellation.dispose()
		}
	}

	/**
	 * Implements the ApiHandler countTokens interface method
	 * Provides token counting for Anthropic content blocks
	 *
	 * @param content The content blocks to count tokens for
	 * @returns A promise resolving to the token count
	 */
	override async countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number> {
		// Convert Anthropic content blocks to a string for VSCode LM token counting
		let textContent = ""

		for (const block of content) {
			if (block.type === "text") {
				textContent += block.text || ""
			} else if (block.type === "image") {
				// VSCode LM doesn't support images directly, so we'll just use a placeholder
				textContent += "[IMAGE]"
			}
		}

		return this.internalCountTokens(textContent)
	}

	/**
	 * Private implementation of token counting used internally by VsCodeLmHandler
	 */
	private async internalCountTokens(text: string | vscode.LanguageModelChatMessage): Promise<number> {
		// Check for required dependencies
		if (!this.client) {
			console.warn("Roo Code <Language Model API>: No client available for token counting")
			return 0
		}

		// Validate input
		if (!text) {
			console.debug("Roo Code <Language Model API>: Empty text provided for token counting")
			return 0
		}

		// Create a temporary cancellation token if we don't have one (e.g., when called outside a request)
		let cancellationToken: vscode.CancellationToken
		let tempCancellation: vscode.CancellationTokenSource | null = null

		if (this.currentRequestCancellation) {
			cancellationToken = this.currentRequestCancellation.token
		} else {
			tempCancellation = new vscode.CancellationTokenSource()
			cancellationToken = tempCancellation.token
		}

		try {
			// Handle different input types
			let tokenCount: number

			if (typeof text === "string") {
				tokenCount = await this.client.countTokens(text, cancellationToken)
			} else if (text instanceof vscode.LanguageModelChatMessage) {
				// For chat messages, ensure we have content
				if (!text.content || (Array.isArray(text.content) && text.content.length === 0)) {
					console.debug("Roo Code <Language Model API>: Empty chat message content")
					return 0
				}
				const countMessage = extractTextCountFromMessage(text)
				tokenCount = await this.client.countTokens(countMessage, cancellationToken)
			} else {
				console.warn("Roo Code <Language Model API>: Invalid input type for token counting")
				return 0
			}

			// Validate the result
			if (typeof tokenCount !== "number") {
				console.warn("Roo Code <Language Model API>: Non-numeric token count received:", tokenCount)
				return 0
			}

			if (tokenCount < 0) {
				console.warn("Roo Code <Language Model API>: Negative token count received:", tokenCount)
				return 0
			}

			return tokenCount
		} catch (error) {
			// Handle specific error types
			if (error instanceof vscode.CancellationError) {
				console.debug("Roo Code <Language Model API>: Token counting cancelled by user")
				return 0
			}

			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			console.warn("Roo Code <Language Model API>: Token counting failed:", errorMessage)

			// Log additional error details if available
			if (error instanceof Error && error.stack) {
				console.debug("Token counting error stack:", error.stack)
			}

			return 0 // Fallback to prevent stream interruption
		} finally {
			// Clean up temporary cancellation token
			if (tempCancellation) {
				tempCancellation.dispose()
			}
		}
	}

	private async calculateTotalInputTokens(vsCodeLmMessages: vscode.LanguageModelChatMessage[]): Promise<number> {
		const messageTokens: number[] = await Promise.all(vsCodeLmMessages.map((msg) => this.internalCountTokens(msg)))

		return messageTokens.reduce((sum: number, tokens: number): number => sum + tokens, 0)
	}

	private ensureCleanState(): void {
		if (this.currentRequestCancellation) {
			this.currentRequestCancellation.cancel()
			this.currentRequestCancellation.dispose()
			this.currentRequestCancellation = null
		}
	}

	private async getClient(): Promise<vscode.LanguageModelChat> {
		if (!this.client) {
			console.debug("Roo Code <Language Model API>: Getting client with options:", {
				vsCodeLmModelSelector: this.options.vsCodeLmModelSelector,
				hasOptions: !!this.options,
				selectorKeys: this.options.vsCodeLmModelSelector ? Object.keys(this.options.vsCodeLmModelSelector) : [],
			})

			try {
				// Use default empty selector if none provided to get all available models
				const selector = this.options?.vsCodeLmModelSelector || {}
				console.debug("Roo Code <Language Model API>: Creating client with selector:", selector)
				this.client = await this.createClient(selector)
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error"
				console.error("Roo Code <Language Model API>: Client creation failed:", message)
				throw new Error(`Roo Code <Language Model API>: Failed to create client: ${message}`)
			}
		}

		return this.client
	}

	private cleanMessageContent(content: any): any {
		if (!content) {
			return content
		}

		if (typeof content === "string") {
			return content
		}

		if (Array.isArray(content)) {
			return content.map((item) => this.cleanMessageContent(item))
		}

		if (typeof content === "object") {
			const cleaned: any = {}
			for (const [key, value] of Object.entries(content)) {
				cleaned[key] = this.cleanMessageContent(value)
			}
			return cleaned
		}

		return content
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		console.log(
			`[DEEPSEEK-DIAG] VsCodeLmHandler.createMessage: conversationId=${this.conversationId}, parentConversationId=${this.parentConversationId}, rootConversationId=${this.rootConversationId}, msgCount=${messages.length}`,
		)
		// Ensure clean state before starting a new request
		this.ensureCleanState()
		const client: vscode.LanguageModelChat = await this.getClient()

		// Process messages
		const cleanedMessages = messages.map((msg) => ({
			...msg,
			content: this.cleanMessageContent(msg.content),
		}))

		// Convert Anthropic messages to VS Code LM messages
		// Note: systemPrompt is passed via modelOptions since VS Code LM API lacks System role
		const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = convertToVsCodeLmMessages(cleanedMessages)

		// Initialize cancellation token for the request
		this.currentRequestCancellation = new vscode.CancellationTokenSource()

		// Snapshot the per-conversation cumulative cost ledger BEFORE the
		// request so we can yield a per-request delta after the stream
		// completes. The Arkware LLM Model Provider's
		// `arkware.llm.getRequestCost` returns a running cumulative across
		// the whole conversation; if we yielded that as the chunk's
		// `totalCost`, Roo would then store it on each `apiReqInfo` message
		// and re-sum across messages in `consolidateTokenUsage`, multiplying
		// the spend by O(N²) and silently breaking the cost-cap math.
		const conversationCostUsdBefore = await this.fetchArkwareRequestCost()

		// Calculate input tokens before starting the stream
		const totalInputTokens: number = await this.calculateTotalInputTokens(vsCodeLmMessages)

		// Accumulate the text and count at the end of the stream to reduce token counting overhead.
		let accumulatedText: string = ""

		try {
			// Create the response stream with required options
			// systemPrompt is passed in modelOptions for llm-provider to extract and forward
			// as a proper System role message to llm-router
			const { info: modelInfo } = this.getModel()
			const maxTokens =
				this.options.modelMaxTokens ||
				(modelInfo.maxTokens && modelInfo.maxTokens > 0 ? modelInfo.maxTokens : undefined)
			const requestOptions: vscode.LanguageModelChatRequestOptions = {
				justification: `Roo Code would like to use '${client.name}' from '${client.vendor}', Click 'Allow' to proceed.`,
				tools: convertToVsCodeLmTools(metadata?.tools ?? []),
				modelOptions: {
					conversationId: this.conversationId,
					...(this.parentConversationId && { parentConversationId: this.parentConversationId }),
					...(this.rootConversationId && { rootConversationId: this.rootConversationId }),
					systemPrompt,
					...(maxTokens && { maxTokens }),
				},
			}

			// Check if this is a Xiaomi model for enhanced logging
			const isXiaomiModel =
				client.name.toLowerCase().includes("mimo") || client.name.toLowerCase().includes("xiaomi")
			if (isXiaomiModel) {
				const logMsg = `[XIAOMI] RooCode sending request via vscode-lm: ${JSON.stringify(
					{
						model: client.name,
						vendor: client.vendor,
						maxTokens,
						messages_count: vsCodeLmMessages.length,
						tools_count: metadata?.tools?.length ?? 0,
						systemPrompt_length: systemPrompt?.length ?? 0,
						conversationId: this.conversationId,
					},
					null,
					2,
				)}`
				getOutputChannel()?.appendLine(logMsg)
			}

			const response: vscode.LanguageModelChatResponse = await client.sendRequest(
				vsCodeLmMessages,
				requestOptions,
				this.currentRequestCancellation.token,
			)

			// Consume the stream and handle text, thinking, and tool call chunks
			for await (const chunk of response.stream) {
				// Log chunk type for debugging
				if (isXiaomiModel) {
					const chunkType =
						chunk instanceof vscode.LanguageModelTextPart
							? "LanguageModelTextPart"
							: chunk instanceof vscode.LanguageModelThinkingPart
								? "LanguageModelThinkingPart"
								: chunk instanceof vscode.LanguageModelToolCallPart
									? "LanguageModelToolCallPart"
									: "Unknown"
					getOutputChannel()?.appendLine(`[XIAOMI] [vscode-lm] Received chunk type: ${chunkType}`)
				}
				if (chunk instanceof vscode.LanguageModelTextPart) {
					// Validate text part value
					if (typeof chunk.value !== "string") {
						console.warn("Roo Code <Language Model API>: Invalid text part value received:", chunk.value)
						continue
					}

					accumulatedText += chunk.value
					yield {
						type: "text",
						text: chunk.value,
					}
				} else if (chunk instanceof vscode.LanguageModelThinkingPart) {
					// Handle thinking/reasoning content from models like mimo-v2-pro
					if (typeof chunk.value === "string" && chunk.value.trim()) {
						yield {
							type: "reasoning",
							text: chunk.value,
						}
					}
				} else if (chunk instanceof vscode.LanguageModelToolCallPart) {
					try {
						// Log tool call details for Xiaomi
						if (isXiaomiModel) {
							getOutputChannel()?.appendLine(
								`[XIAOMI] [vscode-lm] Received LanguageModelToolCallPart: name=${chunk.name}, callId=${chunk.callId}, input=${JSON.stringify(chunk.input)}`,
							)
						}

						// Validate tool call parameters
						if (!chunk.name || typeof chunk.name !== "string") {
							console.warn("Roo Code <Language Model API>: Invalid tool name received:", chunk.name)
							continue
						}

						if (!chunk.callId || typeof chunk.callId !== "string") {
							console.warn("Roo Code <Language Model API>: Invalid tool callId received:", chunk.callId)
							continue
						}

						// Ensure input is a valid object
						if (!chunk.input || typeof chunk.input !== "object") {
							console.warn("Roo Code <Language Model API>: Invalid tool input received:", chunk.input)
							continue
						}

						// Log tool call for debugging
						console.debug("Roo Code <Language Model API>: Processing tool call:", {
							name: chunk.name,
							callId: chunk.callId,
							inputSize: JSON.stringify(chunk.input).length,
						})

						// Yield native tool_call chunk when tools are provided
						if (metadata?.tools?.length) {
							const argumentsString = JSON.stringify(chunk.input)
							accumulatedText += argumentsString
							if (isXiaomiModel) {
								getOutputChannel()?.appendLine(
									`[XIAOMI] [vscode-lm] Yielding tool_call: id=${chunk.callId}, name=${chunk.name}, args=${argumentsString}`,
								)
							}
							yield {
								type: "tool_call",
								id: chunk.callId,
								name: chunk.name,
								arguments: argumentsString,
							}
						} else {
							if (isXiaomiModel) {
								getOutputChannel()?.appendLine(
									`[XIAOMI] [vscode-lm] NOT yielding tool_call - no tools in metadata`,
								)
							}
						}
					} catch (error) {
						console.error("Roo Code <Language Model API>: Failed to process tool call:", error)
						// Continue processing other chunks even if one fails
						continue
					}
				} else {
					console.warn("Roo Code <Language Model API>: Unknown chunk type received:", chunk)
				}
			}

			// Count tokens in the accumulated text after stream completion
			const totalOutputTokens: number = await this.internalCountTokens(accumulatedText)

			// Log complete stream summary for Xiaomi models
			if (isXiaomiModel) {
				const logMsg = `[XIAOMI] RooCode stream complete: ${JSON.stringify(
					{
						model: client.name,
						total_input_tokens: totalInputTokens,
						total_output_tokens: totalOutputTokens,
						accumulated_text_length: accumulatedText.length,
						accumulated_text_preview: accumulatedText.slice(0, 500),
					},
					null,
					2,
				)}`
				getOutputChannel()?.appendLine(logMsg)
			}

			// Pull the per-conversation USD cost computed by llm-router and
			// accumulated by the Arkware LLM Model Provider extension. This
			// is the only reliable cost source for composite (`arkware/*`)
			// models, where the underlying that served the request is
			// selected at request time and `getModel().info.inputPrice` is
			// therefore zero. We compare against the pre-request snapshot
			// taken above and yield the DELTA as `totalCost` (= the
			// per-request cost), so Roo's per-message accounting and the
			// consolidate-then-sum pipeline don't double-count.
			const conversationCostUsdAfter = await this.fetchArkwareRequestCost()
			let perRequestCostUsd: number | undefined
			if (conversationCostUsdAfter !== undefined) {
				const before = conversationCostUsdBefore ?? 0
				const delta = conversationCostUsdAfter - before
				// Guard against ledger-eviction or out-of-order updates that
				// could produce a negative delta; clamp to zero rather than
				// emit a nonsensical refund.
				perRequestCostUsd = delta >= 0 ? delta : 0
				getOutputChannel()?.appendLine(
					`[vscode-lm] cost ledger: before=${before}, after=${conversationCostUsdAfter}, perRequest=${perRequestCostUsd}, conversationId=${this.conversationId}`,
				)
			}

			// Report final usage after stream completion
			yield {
				type: "usage",
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
				...(perRequestCostUsd !== undefined ? { totalCost: perRequestCostUsd } : {}),
			}
		} catch (error: unknown) {
			this.ensureCleanState()

			if (error instanceof vscode.CancellationError) {
				throw new Error("Roo Code <Language Model API>: Request cancelled by user")
			}

			if (error instanceof Error) {
				console.error("Roo Code <Language Model API>: Stream error details:", {
					message: error.message,
					stack: error.stack,
					name: error.name,
				})

				// Return original error if it's already an Error instance
				throw error
			} else if (typeof error === "object" && error !== null) {
				// Handle error-like objects
				const errorDetails = JSON.stringify(error, null, 2)
				console.error("Roo Code <Language Model API>: Stream error object:", errorDetails)
				throw new Error(`Roo Code <Language Model API>: Response stream error: ${errorDetails}`)
			} else {
				// Fallback for unknown error types
				const errorMessage = String(error)
				console.error("Roo Code <Language Model API>: Unknown stream error:", errorMessage)
				throw new Error(`Roo Code <Language Model API>: Response stream error: ${errorMessage}`)
			}
		}
	}

	// Return model information based on the current client state
	override getModel(): { id: string; info: ModelInfo } {
		if (this.client) {
			// Validate client properties
			const requiredProps = {
				id: this.client.id,
				vendor: this.client.vendor,
				family: this.client.family,
				version: this.client.version,
				maxInputTokens: this.client.maxInputTokens,
			}

			// Log any missing properties for debugging
			for (const [prop, value] of Object.entries(requiredProps)) {
				if (!value && value !== 0) {
					console.warn(`Roo Code <Language Model API>: Client missing ${prop} property`)
				}
			}

			// Construct model ID using available information
			const modelParts = [this.client.vendor, this.client.family, this.client.version].filter(Boolean)

			const modelId = this.client.id || modelParts.join(SELECTOR_SEPARATOR)

			// Build model info with conservative defaults for missing values
			console.log(
				`[CONTEXT-DIAG] vscode-lm getModel() — client.id=${this.client.id}, ` +
					`maxInputTokens=${this.client.maxInputTokens} (type=${typeof this.client.maxInputTokens})`,
			)
			const modelInfo: ModelInfo = {
				maxTokens: -1, // Unlimited tokens by default
				// Context window must come from llm-router (via
				// `client.maxInputTokens`). Falling back to a static default
				// silently corrupts condensation/truncation math when the model
				// supports far more (e.g. 1M-token deepseek-v4-pro), so leave it
				// at 0 if the upstream value is missing — consumers will surface
				// the misconfiguration instead of hiding it behind a 128K guess.
				contextWindow:
					typeof this.client.maxInputTokens === "number" ? Math.max(0, this.client.maxInputTokens) : 0,
				// Capability flags are sourced from llm-router's model registry
				// via the arkware side-channel. Conservative `false` default
				// applies only when the side channel is unavailable.
				supportsImages: this.arkwareCapabilities?.imageInput ?? false,
				supportsPromptCache: this.arkwareCapabilities?.promptCache ?? false,
				inputPrice: this.arkwarePricing?.inputPrice ?? 0,
				outputPrice: this.arkwarePricing?.outputPrice ?? 0,
				...(this.arkwarePricing?.cacheReadsPrice !== undefined && {
					cacheReadsPrice: this.arkwarePricing.cacheReadsPrice,
				}),
				...(this.arkwarePricing?.cacheWritesPrice !== undefined && {
					cacheWritesPrice: this.arkwarePricing.cacheWritesPrice,
				}),
				description: `VSCode Language Model: ${modelId}`,
			}

			return { id: modelId, info: modelInfo }
		}

		// Fallback when no client is available
		const fallbackId = this.options.vsCodeLmModelSelector
			? stringifyVsCodeLmModelSelector(this.options.vsCodeLmModelSelector)
			: "vscode-lm"

		console.debug("Roo Code <Language Model API>: No client available, using fallback model info")

		return {
			id: fallbackId,
			info: {
				...openAiModelInfoSaneDefaults,
				description: `VSCode Language Model (Fallback): ${fallbackId}`,
			},
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		try {
			const client = await this.getClient()
			const response = await client.sendRequest(
				[vscode.LanguageModelChatMessage.User(prompt)],
				{
					modelOptions: {
						conversationId: this.conversationId,
						...(this.parentConversationId && { parentConversationId: this.parentConversationId }),
						...(this.rootConversationId && { rootConversationId: this.rootConversationId }),
					},
				},
				new vscode.CancellationTokenSource().token,
			)
			let result = ""
			for await (const chunk of response.stream) {
				if (chunk instanceof vscode.LanguageModelTextPart) {
					result += chunk.value
				}
			}
			return result
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`VSCode LM completion error: ${error.message}`)
			}
			throw error
		}
	}
}

// Static blacklist of VS Code Language Model IDs that should be excluded from the model list e.g. because they will never work
const VSCODE_LM_STATIC_BLACKLIST: string[] = ["claude-3.7-sonnet", "claude-3.7-sonnet-thought"]

/**
 * Capability flags exposed by the Arkware LLM Model Provider extension via
 * the `arkware.llm.getModelCapabilities` side-channel command. Mirrors the
 * shape of llm-router's `/v1/models` `capabilities` block.
 */
export interface ArkwareLmCapabilities {
	imageInput: boolean
	toolCalling: boolean
	promptCache: boolean
}

/**
 * Pricing flags exposed by the Arkware LLM Model Provider extension via the
 * `arkware.llm.getModelPricing` side-channel command. USD per 1M tokens.
 */
export interface ArkwareLmPricing {
	inputPrice: number
	outputPrice: number
	cacheReadsPrice?: number
	cacheWritesPrice?: number
}

/**
 * Shape returned to the webview for each VS Code LM model. We can't extend
 * `vscode.LanguageModelChat` (it's a frozen interface), so we project the
 * subset the UI needs and attach Arkware-only fields (`arkwareCapabilities`,
 * `arkwarePricing`) sourced from the side-channel commands. The webview
 * relies on these to render capability/pricing facts without hardcoded
 * assumptions.
 */
export interface VsCodeLmModelDescriptor {
	id: string
	vendor: string
	family: string
	version: string
	name: string
	maxInputTokens: number
	capabilities?: { imageInput?: boolean; toolCalling?: boolean }
	arkwareCapabilities?: ArkwareLmCapabilities
	arkwarePricing?: ArkwareLmPricing
}

/**
 * Enumerate VS Code LM chat models, filter the static blacklist, and enrich
 * each entry with Arkware capability/pricing data fetched from llm-provider.
 *
 * The enrichment uses two side-channel commands
 * (`arkware.llm.getModelCapabilities`, `arkware.llm.getModelPricing`) keyed
 * tolerantly on the model id and the slash-free `family` identifier; this
 * mirrors {@link VsCodeLmHandler.refreshArkwareCapabilities} so both the
 * runtime handler and the webview see the same source of truth. Failures
 * for individual models leave their Arkware fields unset; callers must treat
 * `undefined` as "not available" and not as a capability assertion.
 */
export async function getVsCodeLmModels(): Promise<VsCodeLmModelDescriptor[]> {
	try {
		const models = (await vscode.lm.selectChatModels({})) || []
		const filtered = models.filter((model) => !VSCODE_LM_STATIC_BLACKLIST.includes(model.id))
		return await Promise.all(filtered.map(enrichVsCodeLmModel))
	} catch (error) {
		console.error(
			`Error fetching VS Code LM models: ${JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}`,
		)
		return []
	}
}

async function enrichVsCodeLmModel(model: vscode.LanguageModelChat): Promise<VsCodeLmModelDescriptor> {
	const candidates = [model.id, model.family].filter((s): s is string => typeof s === "string" && s.length > 0)
	let arkwareCapabilities: ArkwareLmCapabilities | undefined
	let arkwarePricing: ArkwareLmPricing | undefined
	for (const candidate of candidates) {
		if (!arkwareCapabilities) {
			try {
				arkwareCapabilities = await vscode.commands.executeCommand<ArkwareLmCapabilities | undefined>(
					"arkware.llm.getModelCapabilities",
					candidate,
				)
			} catch {
				// Side-channel command unavailable (no arkware extension); leave undefined.
			}
		}
		if (!arkwarePricing) {
			try {
				arkwarePricing = await vscode.commands.executeCommand<ArkwareLmPricing | undefined>(
					"arkware.llm.getModelPricing",
					candidate,
				)
			} catch {
				// As above.
			}
		}
		if (arkwareCapabilities && arkwarePricing) break
	}
	// `capabilities` exists at runtime on recent VS Code builds (forwarded via
	// LanguageModelChat) but isn't declared in @types/vscode@1.100.0, so we
	// access it through a structural cast rather than depend on an unstable
	// proposed-API d.ts.
	const runtimeCaps = (model as unknown as { capabilities?: { imageInput?: boolean; toolCalling?: boolean } })
		.capabilities
	return {
		id: model.id,
		vendor: model.vendor,
		family: model.family,
		version: model.version,
		name: model.name,
		maxInputTokens: model.maxInputTokens,
		capabilities: runtimeCaps
			? { imageInput: runtimeCaps.imageInput, toolCalling: runtimeCaps.toolCalling }
			: undefined,
		arkwareCapabilities,
		arkwarePricing,
	}
}
