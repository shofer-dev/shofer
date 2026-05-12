import type { ModelInfo } from "../model.js"

export type VscodeLlmModelId = string

export const vscodeLlmDefaultModelId = ""

/**
 * Capability flags sourced from llm-router's `/v1/models` `capabilities`
 * block and forwarded to the webview by the extension host (which fetches
 * them from llm-provider's `shofer.llm.getModelCapabilities` side-channel
 * command). Single source of truth for capability assertions in the UI;
 * `undefined` means "not available" and must not be treated as false.
 */
export interface shoferLmCapabilities {
	imageInput: boolean
	toolCalling: boolean
	promptCache: boolean
}

/**
 * Pricing information sourced from llm-router via llm-provider's
 * `shofer.llm.getModelPricing` side-channel command. USD per 1M tokens.
 */
export interface shoferLmPricing {
	inputPrice: number
	outputPrice: number
	cacheReadsPrice?: number
	cacheWritesPrice?: number
}

/**
 * Webview-safe mirror of vscode.LanguageModelChatInformation.
 * The real objects arrive via the vsCodeLmModels IPC message and are
 * plain JSON-serializable shapes, so we define the subset we depend on
 * rather than importing vscode types directly into the webview bundle.
 *
 * The `shoferCapabilities` and `shoferPricing` fields carry data that
 * VS Code's own `LanguageModelChatProviderCapabilities` cannot represent
 * (notably prompt-cache support and per-token pricing); the extension
 * host enriches each entry from llm-provider's side-channel commands
 * before posting to the webview, so all consumers can rely on llm-router
 * as the single source of truth instead of hardcoding capability flags.
 */
export interface VsCodeLmChatInfo {
	id?: string
	name?: string
	vendor?: string
	family?: string
	version?: string
	/** Context window advertised by the provider extension (llm-provider → llm-router → model_registry.go). */
	maxInputTokens?: number
	/** VS Code's native capability surface (limited to imageInput + toolCalling). */
	capabilities?: { imageInput?: boolean; toolCalling?: boolean }
	/** Full Shofer capability set, including promptCache. */
	shoferCapabilities?: shoferLmCapabilities
	/** Per-token pricing from llm-router. */
	shoferPricing?: shoferLmPricing
}

// Static map kept for type compatibility. All model info (including
// contextWindow) is resolved dynamically via the vsCodeLmModels context
// populated by the extension host through vscode.lm.selectChatModels,
// which carries the real maxInputTokens from each registered provider
// (e.g. llm-provider → llm-router → model_registry.go).
export const vscodeLlmModels: Record<string, ModelInfo> = {}
