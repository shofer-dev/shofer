import type { ModelInfo } from "../model.js"

export type VscodeLlmModelId = string

export const vscodeLlmDefaultModelId = ""

/**
 * Webview-safe mirror of vscode.LanguageModelChatInformation.
 * The real objects arrive via the vsCodeLmModels IPC message and are
 * plain JSON-serializable shapes, so we define the subset we depend on
 * rather than importing vscode types directly into the webview bundle.
 */
export interface VsCodeLmChatInfo {
	id?: string
	name?: string
	vendor?: string
	family?: string
	version?: string
	/** Context window advertised by the provider extension (llm-provider → llm-router → model_registry.go). */
	maxInputTokens?: number
}

// Static map kept for type compatibility. All model info (including
// contextWindow) is resolved dynamically via the vsCodeLmModels context
// populated by the extension host through vscode.lm.selectChatModels,
// which carries the real maxInputTokens from each registered provider
// (e.g. llm-provider → llm-router → model_registry.go).
export const vscodeLlmModels: Record<string, ModelInfo> = {}
