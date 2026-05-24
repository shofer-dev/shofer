import { ApiHandlerOptions } from "../../../shared/api"
import { EmbedderInfo, EmbeddingResponse, IEmbedder } from "../interfaces"
import { getModelQueryPrefix } from "../../../shared/embeddingModels"
import { t } from "../../../i18n"
import { withValidationErrorHandling, sanitizeErrorMessage } from "../shared/validation-helpers"
import { TelemetryService } from "@shofer/telemetry"
import { TelemetryEventName } from "@shofer/types"
import { outputError } from "../../../utils/outputChannelLogger"

// Timeout constants for Ollama API requests
const OLLAMA_EMBEDDING_TIMEOUT_MS = 60000 // 60 seconds for embedding requests
const OLLAMA_VALIDATION_TIMEOUT_MS = 30000 // 30 seconds for validation requests

/**
 * Diagnostic logger that lazily resolves the shared Shofer output channel.
 *
 * Static import of `../../../extension` would form a require-cycle
 * (extension → code-index/manager → … → embedders/ollama). The lazy
 * dynamic import keeps the cycle out of the module graph while still routing
 * diagnostics to the user-visible channel per the Output Channel Logging Rule.
 */
function log(...args: unknown[]): void {
	void import("../../../extension")
		.then(({ getOutputChannel }) => {
			const ch = getOutputChannel()
			if (!ch) return
			const stamp = new Date().toISOString()
			for (const arg of args) {
				const body = typeof arg === "string" ? arg : JSON.stringify(arg)
				ch.appendLine(`${stamp} [code-index/ollama] ${body}`)
			}
		})
		.catch(() => {
			/* output channel not yet wired; silently drop */
		})
}

/**
 * Implements the IEmbedder interface using a local Ollama instance.
 */
export class CodeIndexOllamaEmbedder implements IEmbedder {
	private readonly baseUrl: string
	private readonly defaultModelId: string

	// Cached per-model context-window probe.  Ollama silently ignores
	// `options.num_ctx` above the model's training-time max sequence length
	// (e.g. nomic-embed-text is 2048), so we must read the real value from
	// `/api/show` rather than assume MAX_ITEM_TOKENS (8191) applies.  Keyed by
	// model id; the promise is cached so concurrent calls share one probe.
	private readonly _modelContextCache = new Map<string, Promise<number>>()

	// Conservative chars-per-token ratio for English text *including code*,
	// commit messages, identifiers, and short fragments.  The standard /4
	// heuristic under-counts for punctuation-dense code; empirically a 7000-
	// char commit hit the 2048-token wall on nomic-embed-text, implying a real
	// ratio < 3.5 chars/token for that content.  2.5 chars/token gives a safe
	// budget for typical mixed English+code without being CJK-pessimistic.
	private static readonly CHARS_PER_TOKEN = 2.5

	// Tokens reserved for special tokens (BOS/EOS) and model overhead.  Ollama
	// counts these against num_ctx, so the usable budget for input text is
	// strictly less than the model's declared context length.
	private static readonly TOKEN_OVERHEAD = 8

	// Fallback context length when /api/show probe fails or returns no value.
	// Matches Ollama's runtime default; deliberately pessimistic.
	private static readonly FALLBACK_CONTEXT_TOKENS = 2048

	constructor(options: ApiHandlerOptions) {
		// Ensure ollamaBaseUrl and ollamaModelId exist on ApiHandlerOptions or add defaults
		let baseUrl = options.ollamaBaseUrl || "http://localhost:11434"

		// Normalize the baseUrl by removing all trailing slashes
		baseUrl = baseUrl.replace(/\/+$/, "")

		this.baseUrl = baseUrl
		this.defaultModelId = options.ollamaModelId || "nomic-embed-text:latest"
	}

	/**
	 * Probes Ollama's `/api/show` for the model's actual training-time context
	 * length, cached per model id.  Returns FALLBACK_CONTEXT_TOKENS on any error.
	 *
	 * The response's `model_info` object contains an architecture-prefixed key
	 * like `"nomic-bert.context_length"`, `"llama.context_length"`, etc.  We
	 * scan all `*.context_length` keys and take the min (defensive).
	 */
	private getModelContextTokens(modelId: string): Promise<number> {
		const cached = this._modelContextCache.get(modelId)
		if (cached) return cached

		const probe = (async (): Promise<number> => {
			try {
				const controller = new AbortController()
				const timeoutId = setTimeout(() => controller.abort(), OLLAMA_VALIDATION_TIMEOUT_MS)
				const resp = await fetch(`${this.baseUrl}/api/show`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: modelId }),
					signal: controller.signal,
				})
				clearTimeout(timeoutId)
				if (!resp.ok) {
					log(
						`/api/show ${resp.status} ${resp.statusText} for ${modelId} — ` +
							`falling back to ${CodeIndexOllamaEmbedder.FALLBACK_CONTEXT_TOKENS} tokens`,
					)
					return CodeIndexOllamaEmbedder.FALLBACK_CONTEXT_TOKENS
				}
				const data: any = await resp.json()
				const modelInfo: Record<string, unknown> = data?.model_info ?? {}
				const ctxValues = Object.entries(modelInfo)
					.filter(([k, v]) => k.endsWith(".context_length") && typeof v === "number")
					.map(([, v]) => v as number)
				const resolved =
					ctxValues.length > 0 ? Math.min(...ctxValues) : CodeIndexOllamaEmbedder.FALLBACK_CONTEXT_TOKENS
				log(
					`/api/show ${modelId} context_length=${resolved} tokens (sources: ${ctxValues.join(",") || "none"})`,
				)
				return resolved
			} catch (err: any) {
				log(
					`/api/show probe failed for ${modelId}: ${err?.message ?? err} — ` +
						`falling back to ${CodeIndexOllamaEmbedder.FALLBACK_CONTEXT_TOKENS} tokens`,
				)
				return CodeIndexOllamaEmbedder.FALLBACK_CONTEXT_TOKENS
			}
		})()

		this._modelContextCache.set(modelId, probe)
		return probe
	}

	/**
	 * Creates embeddings for the given texts using the specified Ollama model.
	 * @param texts - An array of strings to embed.
	 * @param model - Optional model ID to override the default.
	 * @returns A promise that resolves to an EmbeddingResponse containing the embeddings and usage data.
	 */
	async createEmbeddings(texts: string[], model?: string, signal?: AbortSignal): Promise<EmbeddingResponse> {
		const modelToUse = model || this.defaultModelId
		const url = `${this.baseUrl}/api/embed` // Endpoint as specified

		// Resolve the real model context window before we size truncation or
		// num_ctx.  Cached per model, so this is one extra request the first time
		// each model is used.
		const modelContextTokens = await this.getModelContextTokens(modelToUse)
		const usableTokens = Math.max(1, modelContextTokens - CodeIndexOllamaEmbedder.TOKEN_OVERHEAD)
		const maxSafeChars = Math.floor(usableTokens * CodeIndexOllamaEmbedder.CHARS_PER_TOKEN)

		// Apply model-specific query prefix if required
		const queryPrefix = getModelQueryPrefix("ollama", modelToUse)
		const prefixedTexts = queryPrefix
			? texts.map((text, index) => {
					// Prevent double-prefixing
					if (text.startsWith(queryPrefix)) {
						return text
					}
					const prefixedText = `${queryPrefix}${text}`
					if (prefixedText.length > maxSafeChars) {
						log(
							`prefix would overflow item ${index}: ` +
								`${prefixedText.length} chars > ${maxSafeChars} cap — dropping prefix`,
						)
						return text
					}
					return prefixedText
				})
			: texts

		// Defence-in-depth: hard character cap derived from the model's actual
		// context length (probed via /api/show), not the static MAX_ITEM_TOKENS.
		// Ollama silently caps `options.num_ctx` at the model's training-time max
		// for embedding models, so sizing to MAX_ITEM_TOKENS=8191 was meaningless
		// for nomic-embed-text (2048).
		const processedTexts = prefixedTexts.map((text, index) => {
			if (text.length > maxSafeChars) {
				const originalLen = text.length
				const truncated = text.substring(0, maxSafeChars)
				log(
					`truncation: item ${index} ${originalLen} chars > ${maxSafeChars} cap ` +
						`(usable=${usableTokens} tokens × ${CodeIndexOllamaEmbedder.CHARS_PER_TOKEN} chars/token), ` +
						`truncated to ${truncated.length}`,
				)
				return truncated
			}
			return text
		})

		try {
			// Note: Standard Ollama API uses 'prompt' for single text, not 'input' for array.
			// Implementing based on user's specific request structure.

			// Diagnostic: pre-request summary so we can correlate 400s with payload size.
			const itemLengths = processedTexts.map((s) => s.length)
			const totalChars = itemLengths.reduce((a, b) => a + b, 0)
			const maxChars = itemLengths.length > 0 ? Math.max(...itemLengths) : 0
			const maxIdx = itemLengths.indexOf(maxChars)
			log(
				`POST ${url} model=${modelToUse} items=${itemLengths.length} ` +
					`totalChars=${totalChars} maxChars=${maxChars} (item ${maxIdx}) ` +
					`modelCtx=${modelContextTokens} usableTokens=${usableTokens} cap=${maxSafeChars}`,
			)

			// Merge the external abort signal (e.g. from the orchestrator's "Stop
			// Indexing") with the internal 60 s timeout so that whichever fires
			// first wins.  Without the external signal the timeout is the sole
			// abort guard; with it the user can cancel in-flight embedding work
			// immediately.
			const timeoutController = new AbortController()
			const timeoutId = setTimeout(() => timeoutController.abort(), OLLAMA_EMBEDDING_TIMEOUT_MS)

			const effectiveSignal = signal
				? AbortSignal.any([signal, timeoutController.signal])
				: timeoutController.signal

			// Clean up the timeout when the external signal fires so we don't
			// leak a dangling timer.
			if (signal) {
				signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timeoutId)
					},
					{ once: true },
				)
			}

			// Diagnostic: log the full text of each item being sent to Ollama
			// for vector construction.
			for (let i = 0; i < processedTexts.length; i++) {
				log(`embed item[${i}] (len=${processedTexts[i].length}): ${processedTexts[i]}`)
			}

			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: modelToUse,
					input: processedTexts,
					// Tell Ollama to load the model with the full probed context.
					// Ollama silently caps this at the model's training-time max for
					// embedding models, so setting it higher than `modelContextTokens`
					// is harmless but redundant; we pass exactly that value.
					options: { num_ctx: modelContextTokens },
				}),
				signal: effectiveSignal,
			})
			clearTimeout(timeoutId)

			if (!response.ok) {
				let errorBody = t("embeddings:ollama.couldNotReadErrorBody")
				try {
					errorBody = await response.text()
				} catch (e) {
					// Ignore error reading body
				}
				// Diagnostic: dump per-item lengths so we can see which input the
				// server is rejecting on a 400 "input length exceeds context length".
				log(
					`ERROR ${response.status} ${response.statusText} from ${url} ` +
						`model=${modelToUse} modelCtx=${modelContextTokens} cap=${maxSafeChars} ` +
						`items=${itemLengths.length} maxChars=${maxChars} totalChars=${totalChars} ` +
						`itemLengths=[${itemLengths.join(",")}] body=${errorBody}`,
				)
				throw new Error(
					t("embeddings:ollama.requestFailed", {
						status: response.status,
						statusText: response.statusText,
						errorBody,
					}),
				)
			}

			const data = await response.json()

			// Extract embeddings using 'embeddings' key as requested
			const embeddings = data.embeddings
			if (!embeddings || !Array.isArray(embeddings)) {
				throw new Error(t("embeddings:ollama.invalidResponseStructure"))
			}

			return {
				embeddings: embeddings,
			}
		} catch (error: any) {
			// Capture telemetry before reformatting the error
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
				stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
				location: "OllamaEmbedder:createEmbeddings",
			})

			// Log the original error for debugging purposes
			outputError("Ollama embedding failed:", error)

			// Handle specific error types with better messages
			if (error.name === "AbortError") {
				throw new Error(t("embeddings:validation.connectionFailed"))
			} else if (error.message?.includes("fetch failed") || error.code === "ECONNREFUSED") {
				throw new Error(t("embeddings:ollama.serviceNotRunning", { baseUrl: this.baseUrl }))
			} else if (error.code === "ENOTFOUND") {
				throw new Error(t("embeddings:ollama.hostNotFound", { baseUrl: this.baseUrl }))
			}

			// Re-throw a more specific error for the caller
			throw new Error(t("embeddings:ollama.embeddingFailed", { message: error.message }))
		}
	}

	/**
	 * Validates the Ollama embedder configuration by checking service availability and model existence
	 * @returns Promise resolving to validation result with success status and optional error message
	 */
	async validateConfiguration(): Promise<{ valid: boolean; error?: string }> {
		return withValidationErrorHandling(
			async () => {
				// First check if Ollama service is running by trying to list models
				const modelsUrl = `${this.baseUrl}/api/tags`

				// Add timeout to prevent indefinite hanging
				const controller = new AbortController()
				const timeoutId = setTimeout(() => controller.abort(), OLLAMA_VALIDATION_TIMEOUT_MS)

				const modelsResponse = await fetch(modelsUrl, {
					method: "GET",
					headers: {
						"Content-Type": "application/json",
					},
					signal: controller.signal,
				})
				clearTimeout(timeoutId)

				if (!modelsResponse.ok) {
					if (modelsResponse.status === 404) {
						return {
							valid: false,
							error: t("embeddings:ollama.serviceNotRunning", { baseUrl: this.baseUrl }),
						}
					}
					return {
						valid: false,
						error: t("embeddings:ollama.serviceUnavailable", {
							baseUrl: this.baseUrl,
							status: modelsResponse.status,
						}),
					}
				}

				// Check if the specific model exists
				const modelsData = await modelsResponse.json()
				const models = modelsData.models || []

				// Check both with and without :latest suffix
				const modelExists = models.some((m: any) => {
					const modelName = m.name || ""
					return (
						modelName === this.defaultModelId ||
						modelName === `${this.defaultModelId}:latest` ||
						modelName === this.defaultModelId.replace(":latest", "")
					)
				})

				if (!modelExists) {
					const availableModels = models.map((m: any) => m.name).join(", ")
					return {
						valid: false,
						error: t("embeddings:ollama.modelNotFound", {
							modelId: this.defaultModelId,
							availableModels,
						}),
					}
				}

				// Try a test embedding to ensure the model works for embeddings
				const testUrl = `${this.baseUrl}/api/embed`

				// Add timeout for test request too
				const testController = new AbortController()
				const testTimeoutId = setTimeout(() => testController.abort(), OLLAMA_VALIDATION_TIMEOUT_MS)

				const testResponse = await fetch(testUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						model: this.defaultModelId,
						input: ["test"],
					}),
					signal: testController.signal,
				})
				clearTimeout(testTimeoutId)

				if (!testResponse.ok) {
					return {
						valid: false,
						error: t("embeddings:ollama.modelNotEmbeddingCapable", { modelId: this.defaultModelId }),
					}
				}

				return { valid: true }
			},
			"ollama",
			{
				beforeStandardHandling: (error: any) => {
					// Handle Ollama-specific connection errors
					// Check for fetch failed errors which indicate Ollama is not running
					if (
						error?.message?.includes("fetch failed") ||
						error?.code === "ECONNREFUSED" ||
						error?.message?.includes("ECONNREFUSED")
					) {
						// Capture telemetry for connection failed error
						TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
							error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
							stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
							location: "OllamaEmbedder:validateConfiguration:connectionFailed",
						})
						return {
							valid: false,
							error: t("embeddings:ollama.serviceNotRunning", { baseUrl: this.baseUrl }),
						}
					} else if (error?.code === "ENOTFOUND" || error?.message?.includes("ENOTFOUND")) {
						// Capture telemetry for host not found error
						TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
							error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
							stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
							location: "OllamaEmbedder:validateConfiguration:hostNotFound",
						})
						return {
							valid: false,
							error: t("embeddings:ollama.hostNotFound", { baseUrl: this.baseUrl }),
						}
					} else if (error?.name === "AbortError") {
						// Capture telemetry for timeout error
						TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
							error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
							stack: error instanceof Error ? sanitizeErrorMessage(error.stack || "") : undefined,
							location: "OllamaEmbedder:validateConfiguration:timeout",
						})
						// Handle timeout
						return {
							valid: false,
							error: t("embeddings:validation.connectionFailed"),
						}
					}
					// Let standard handling take over
					return undefined
				},
			},
		)
	}

	get embedderInfo(): EmbedderInfo {
		return {
			name: "ollama",
		}
	}
}
