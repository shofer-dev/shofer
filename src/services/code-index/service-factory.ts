import * as vscode from "vscode"

import type { EmbedderProvider } from "@shofer/types"
import type { IIgnoreFilter } from "./shared/git-ignore-filter"
import { TelemetryService } from "@shofer/telemetry"
import { TelemetryEventName } from "@shofer/types"

import { t } from "../../i18n"

import { getDefaultModelId, getModelDimension } from "../../shared/embeddingModels"
import { Package } from "../../shared/package"

import { ShoferIgnoreController } from "../../core/ignore/ShoferIgnoreController"

import { OpenAiEmbedder } from "./embedders/openai"
import { CodeIndexOllamaEmbedder } from "./embedders/ollama"
import { OpenAICompatibleEmbedder } from "./embedders/openai-compatible"
import { GeminiEmbedder } from "./embedders/gemini"
import { MistralEmbedder } from "./embedders/mistral"
import { VercelAiGatewayEmbedder } from "./embedders/vercel-ai-gateway"
import { BedrockEmbedder } from "./embedders/bedrock"
import { OpenRouterEmbedder } from "./embedders/openrouter"
import { getEmbedderLane } from "./embedders/embedder-lane"
import { SerializedEmbedder } from "./embedders/serialized-embedder"
import { QdrantVectorStore } from "./vector-store/qdrant-client"
import { codeParser, DirectoryScanner, FileWatcher } from "./processors"
import { ICodeParser, IEmbedder, IFileWatcher, IVectorStore } from "./interfaces"
import { CodeIndexConfigManager } from "./config-manager"
import { CacheManager } from "./cache-manager"
import {
	BATCH_SEGMENT_THRESHOLD,
	MAX_SERVICE_ATTEMPTS,
	SERVICE_INITIAL_RETRY_DELAY_MS,
	SERVICE_MAX_BACKOFF_MS,
} from "./constants"
import { retryWithBackoff } from "./shared/retry"

/**
 * Options for constructing a {@link CodeIndexServiceFactory}.
 */
export interface CodeIndexServiceFactoryOptions {
	configManager: CodeIndexConfigManager
	workspacePath: string
	cacheManager: CacheManager
	/** Optional callback fired during embedder-validation retries so the UI can surface progress. */
	notifyRetryStatus?: (msg: string) => void
	/** Path used for Qdrant collection naming. Defaults to workspacePath.
	 *  Set to the main repo path for worktrees so linked worktrees share
	 *  the same Qdrant collection. */
	indexKeyPath?: string
}

/**
 * Factory class responsible for creating and configuring code indexing service dependencies.
 */
export class CodeIndexServiceFactory {
	private readonly configManager: CodeIndexConfigManager
	private readonly workspacePath: string
	private readonly cacheManager: CacheManager
	private readonly notifyRetryStatus: ((msg: string) => void) | undefined
	private readonly indexKeyPath: string

	constructor(options: CodeIndexServiceFactoryOptions) {
		this.configManager = options.configManager
		this.workspacePath = options.workspacePath
		this.cacheManager = options.cacheManager
		this.notifyRetryStatus = options.notifyRetryStatus
		this.indexKeyPath = options.indexKeyPath ?? options.workspacePath
	}

	/**
	 * Creates an embedder instance based on the current configuration.
	 *
	 * The concrete embedder is wrapped in a `SerializedEmbedder` decorator so
	 * that every embedder produced by this factory — across the code-index
	 * and git-history subsystems — funnels `createEmbeddings` calls through a
	 * shared per-provider concurrency lane. Without this, simultaneous batches
	 * from the two subsystems saturate single-model backends (Ollama) and
	 * the slower caller times out. See `embedders/embedder-lane.ts` for the
	 * concurrency policy.
	 */
	public createEmbedder(): IEmbedder {
		const config = this.configManager.getConfig()
		const provider = config.embedderProvider as EmbedderProvider
		const inner = this._instantiateEmbedder(config, provider)
		return new SerializedEmbedder(inner, getEmbedderLane(provider))
	}

	/**
	 * Provider switch. Kept private so callers always go through the
	 * lane-wrapped `createEmbedder`.
	 */
	private _instantiateEmbedder(
		config: ReturnType<CodeIndexConfigManager["getConfig"]>,
		provider: EmbedderProvider,
	): IEmbedder {
		if (provider === "openai") {
			const apiKey = config.openAiOptions?.openAiNativeApiKey

			if (!apiKey) {
				throw new Error(t("embeddings:serviceFactory.openAiConfigMissing"))
			}
			return new OpenAiEmbedder({
				...config.openAiOptions,
				openAiEmbeddingModelId: config.modelId,
			})
		} else if (provider === "ollama") {
			if (!config.ollamaOptions?.ollamaBaseUrl) {
				throw new Error(t("embeddings:serviceFactory.ollamaConfigMissing"))
			}
			return new CodeIndexOllamaEmbedder({
				...config.ollamaOptions,
				ollamaModelId: config.modelId,
			})
		} else if (provider === "openai-compatible") {
			if (!config.openAiCompatibleOptions?.baseUrl || !config.openAiCompatibleOptions?.apiKey) {
				throw new Error(t("embeddings:serviceFactory.openAiCompatibleConfigMissing"))
			}
			return new OpenAICompatibleEmbedder(
				config.openAiCompatibleOptions.baseUrl,
				config.openAiCompatibleOptions.apiKey,
				config.modelId,
			)
		} else if (provider === "gemini") {
			if (!config.geminiOptions?.apiKey) {
				throw new Error(t("embeddings:serviceFactory.geminiConfigMissing"))
			}
			return new GeminiEmbedder(config.geminiOptions.apiKey, config.modelId)
		} else if (provider === "mistral") {
			if (!config.mistralOptions?.apiKey) {
				throw new Error(t("embeddings:serviceFactory.mistralConfigMissing"))
			}
			return new MistralEmbedder(config.mistralOptions.apiKey, config.modelId)
		} else if (provider === "vercel-ai-gateway") {
			if (!config.vercelAiGatewayOptions?.apiKey) {
				throw new Error(t("embeddings:serviceFactory.vercelAiGatewayConfigMissing"))
			}
			return new VercelAiGatewayEmbedder(config.vercelAiGatewayOptions.apiKey, config.modelId)
		} else if (provider === "bedrock") {
			// Only region is required for Bedrock (profile is optional)
			if (!config.bedrockOptions?.region) {
				throw new Error(t("embeddings:serviceFactory.bedrockConfigMissing"))
			}
			return new BedrockEmbedder(config.bedrockOptions.region, config.bedrockOptions.profile, config.modelId)
		} else if (provider === "openrouter") {
			if (!config.openRouterOptions?.apiKey) {
				throw new Error(t("embeddings:serviceFactory.openRouterConfigMissing"))
			}
			return new OpenRouterEmbedder(
				config.openRouterOptions.apiKey,
				config.modelId,
				undefined, // maxItemTokens
				config.openRouterOptions.specificProvider,
			)
		}

		throw new Error(
			t("embeddings:serviceFactory.invalidEmbedderType", { embedderProvider: config.embedderProvider }),
		)
	}

	/**
	 * Validates an embedder instance to ensure it's properly configured.
	 * Retries with exponential backoff if the embedder is temporarily unreachable
	 * (e.g. Ollama restarting).
	 *
	 * @param embedder The embedder instance to validate
	 * @returns Promise resolving to validation result
	 */
	public async validateEmbedder(embedder: IEmbedder): Promise<{ valid: boolean; error?: string }> {
		// Track the last attempt that ran so the terminal telemetry event can carry
		// `retryAttempts` instead of fanning out one event per retry (5× amplification).
		let lastAttempt = 1
		try {
			return await retryWithBackoff(() => embedder.validateConfiguration(), {
				maxAttempts: MAX_SERVICE_ATTEMPTS,
				initialDelayMs: SERVICE_INITIAL_RETRY_DELAY_MS,
				maxBackoffMs: SERVICE_MAX_BACKOFF_MS,
				onRetry: (attempt, _error, delayMs) => {
					lastAttempt = attempt
					// Update UI status so user knows embedder is being retried, not stuck.
					this.notifyRetryStatus?.(
						`Embedder connection failed (attempt ${attempt}/${MAX_SERVICE_ATTEMPTS}), retrying in ${Math.round(delayMs / 1000)}s...`,
					)
				},
			})
		} catch (error) {
			// Capture a single telemetry event for the final failure, carrying the
			// retry count so backend dashboards can distinguish transient blips from
			// persistent outages without per-attempt event amplification.
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "validateEmbedder",
				retryAttempts: lastAttempt,
			})

			// If validation throws an exception, preserve the original error message
			return {
				valid: false,
				error: error instanceof Error ? error.message : "embeddings:validation.configurationError",
			}
		}
	}

	/**
	 * Creates a vector store instance using the current configuration.
	 */
	public createVectorStore(): IVectorStore {
		const config = this.configManager.getConfig()

		const provider = config.embedderProvider as EmbedderProvider
		const defaultModel = getDefaultModelId(provider)
		// Use the embedding model ID from config, not the chat model IDs
		const modelId = config.modelId ?? defaultModel

		let vectorSize: number | undefined

		// First try to get the model-specific dimension from profiles
		vectorSize = getModelDimension(provider, modelId)

		// Only use manual dimension if model doesn't have a built-in dimension
		if (!vectorSize && config.modelDimension && config.modelDimension > 0) {
			vectorSize = config.modelDimension
		}

		if (vectorSize === undefined || vectorSize <= 0) {
			if (provider === "openai-compatible") {
				throw new Error(
					t("embeddings:serviceFactory.vectorDimensionNotDeterminedOpenAiCompatible", { modelId, provider }),
				)
			} else {
				throw new Error(t("embeddings:serviceFactory.vectorDimensionNotDetermined", { modelId, provider }))
			}
		}

		if (!config.qdrantUrl) {
			throw new Error(t("embeddings:serviceFactory.qdrantUrlMissing"))
		}

		return new QdrantVectorStore(
			this.workspacePath,
			config.qdrantUrl,
			vectorSize,
			config.qdrantApiKey,
			"ws-",
			undefined,
			this.indexKeyPath,
		)
	}

	/**
	 * Creates a directory scanner instance with its required dependencies.
	 */
	public createDirectoryScanner(
		embedder: IEmbedder,
		vectorStore: IVectorStore,
		parser: ICodeParser,
		ignoreInstance: IIgnoreFilter,
		shoferIgnoreController?: ShoferIgnoreController,
	): DirectoryScanner {
		// Get the configurable batch size from VSCode settings
		let batchSize: number
		try {
			batchSize = vscode.workspace
				.getConfiguration(Package.name)
				.get<number>("codeIndex.embeddingBatchSize", BATCH_SEGMENT_THRESHOLD)
		} catch {
			// In test environment, vscode.workspace might not be available
			batchSize = BATCH_SEGMENT_THRESHOLD
		}
		return new DirectoryScanner(
			embedder,
			vectorStore,
			parser,
			this.cacheManager,
			ignoreInstance,
			batchSize,
			shoferIgnoreController,
		)
	}

	/**
	 * Creates a file watcher instance with its required dependencies.
	 */
	public createFileWatcher(
		context: vscode.ExtensionContext,
		embedder: IEmbedder,
		vectorStore: IVectorStore,
		cacheManager: CacheManager,
		ignoreInstance: IIgnoreFilter,
		shoferIgnoreController?: ShoferIgnoreController,
	): IFileWatcher {
		// Get the configurable batch size from VSCode settings
		let batchSize: number
		try {
			batchSize = vscode.workspace
				.getConfiguration(Package.name)
				.get<number>("codeIndex.embeddingBatchSize", BATCH_SEGMENT_THRESHOLD)
		} catch {
			// In test environment, vscode.workspace might not be available
			batchSize = BATCH_SEGMENT_THRESHOLD
		}
		return new FileWatcher(
			this.workspacePath,
			context,
			cacheManager,
			embedder,
			vectorStore,
			ignoreInstance,
			shoferIgnoreController,
			batchSize,
		)
	}

	/**
	 * Creates all required service dependencies if the service is properly configured.
	 * @throws Error if the service is not properly configured
	 */
	public createServices(
		context: vscode.ExtensionContext,
		cacheManager: CacheManager,
		ignoreInstance: IIgnoreFilter,
		shoferIgnoreController?: ShoferIgnoreController,
	): {
		embedder: IEmbedder
		vectorStore: IVectorStore
		parser: ICodeParser
		scanner: DirectoryScanner
		fileWatcher: IFileWatcher
	} {
		if (!this.configManager.isFeatureConfigured) {
			throw new Error(t("embeddings:serviceFactory.codeIndexingNotConfigured"))
		}

		const embedder = this.createEmbedder()
		const vectorStore = this.createVectorStore()
		const parser = codeParser
		const scanner = this.createDirectoryScanner(
			embedder,
			vectorStore,
			parser,
			ignoreInstance,
			shoferIgnoreController,
		)
		const fileWatcher = this.createFileWatcher(
			context,
			embedder,
			vectorStore,
			cacheManager,
			ignoreInstance,
			shoferIgnoreController,
		)

		return {
			embedder,
			vectorStore,
			parser,
			scanner,
			fileWatcher,
		}
	}
}
