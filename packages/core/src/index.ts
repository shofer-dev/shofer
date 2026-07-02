export * from "./blob-store/BlobStore.js"
export * from "./checkpoints/index.js"
export * from "./custom-tools/index.js"
export * from "./debug-log/index.js"
export * from "./fs/fs.js"
export * from "./ignore/ShoferIgnoreController.js"
export * from "./logging/index.js"
export * from "./logging/subsystems.js"
export * from "./metrics/registry.js"
export * from "./path/path.js"
export * from "./ripgrep/index.js"
export * from "./search/file-search.js"
export * from "./plugins/plugin-registry.js"
export * from "./api/providers/utils/retryable-error.js"
export * from "./api/transform/stream.js"
export * from "./tools/helpers/toolResultFormatting.js"
export * from "./utils/tool-id.js"
export * from "./utils/text-normalization.js"
export * from "./utils/perf.js"
export * from "./utils/tag-matcher.js"
export * from "./utils/mcp-name.js"
export * from "./utils/json-schema.js"
export * from "./context/context-management/context-error-handling.js"
export * from "./message-queue/MessageQueueService.js"
export * from "./task/AskIgnoredError.js"
export * from "./task/validateToolResultIds.js"
export * from "./task/mergeConsecutiveApiMessages.js"
export * from "./task-persistence/message-store.js"
export * from "./task-persistence/apiMessages.js"
export * from "./task-persistence/taskMessages.js"
export * from "./task-persistence/PersistencePort.js"
export * from "./prompts/responses.js"
export * from "./protect/ShoferProtectedController.js"
export * from "./webview/aggregateTaskCosts.js"
export * from "./auto-approval/commands.js"
// Browser-safe shared modules were relocated to @shofer/types (importable by both
// the webview and the Node core). Re-export them here so existing `@shofer/core`
// consumers keep importing them from the core barrel unchanged. NOTE: intentionally
// NOT `export * from "@shofer/types"` — that would collide with core's own
// `TaskProviderLike` (and future overlaps); these are the exact relocated symbols.
export {
	// shared/array
	findLast,
	findLastIndex,
	// shared/cost
	type ApiCostResult,
	calculateApiCostAnthropic,
	calculateApiCostOpenAI,
	parseApiPrice,
	applyCustomPricing,
	// shared/api (provider-api)
	type ApiHandlerOptions,
	type RouterName,
	type GetModelsOptions,
	isRouterName,
	toRouterName,
	shouldUseReasoningBudget,
	shouldUseReasoningEffort,
	getModelMaxOutputTokens,
	DEFAULT_HYBRID_REASONING_MODEL_MAX_TOKENS,
	DEFAULT_HYBRID_REASONING_MODEL_THINKING_TOKENS,
	GEMINI_25_PRO_MIN_THINKING_TOKENS,
	// shared/parse-command
	type ShellToken,
	parseCommand,
	// shared/tools
	type ToolResponse,
	type AskApproval,
	type HandleError,
	type PushToolResult,
	type AskFinishSubTaskApproval,
	type TextContent,
	type ToolParamName,
	type NativeToolArgs,
	type ToolUse,
	type McpToolUse,
	type ExecuteCommandToolUse,
	type ReadFileToolUse,
	type WriteToFileToolUse,
	type RagSearchToolUse,
	type GrepSearchToolUse,
	type GitSearchToolUse,
	type ListFilesToolUse,
	type UseMcpToolToolUse,
	type AccessMcpResourceToolUse,
	type AskFollowupQuestionToolUse,
	type AttemptCompletionToolUse,
	type SwitchModeToolUse,
	type NewTaskToolUse,
	type RunSlashCommandToolUse,
	type SkillsToolUse,
	type GenerateImageToolUse,
	type DiffResult,
	type DiffItem,
	type DiffStrategy,
	toolParamNames,
	// tool metadata (was re-exported via shared/tools.js)
	type ToolGroupConfig,
	TOOL_DISPLAY_NAMES,
	TOOL_GROUPS,
	ALWAYS_AVAILABLE_TOOLS,
	TOOL_ALIASES,
	CROSS_ASSISTANT_ALIASES,
	// shared/modes
	type Mode,
	getGroupName,
	getToolsForMode,
	modes,
	defaultModeSlug,
	getModeBySlug,
	getModeConfig,
	getAllModes,
	isCustomMode,
	findModeBySlug,
	getModeSelection,
	FileRestrictionError,
	defaultPrompts,
	getRoleDefinition,
	getDescription,
	getWhenToUse,
	getCustomInstructions,
	// message-utils
	type ParsedApiReqStartedTextType,
	consolidateTokenUsage,
	hasTokenUsageChanged,
	hasToolUsageChanged,
	consolidateApiRequests,
	consolidateCommands,
	COMMAND_OUTPUT_STRING,
	safeJsonParse,
	// message-utils legacy aliases (combineApiRequests/…)
	combineApiRequests,
	combineCommandSequences,
	getApiMetrics,
	// WebviewMessage shim was deleted; symbols already live in @shofer/types
	type WebviewMessage,
	type WebViewMessagePayload,
	type ShoferAskResponse,
} from "@shofer/types"
export * from "./task-history/index.js"
export * from "./task-provider/index.js"
export * from "./terminal/index.js"
export * from "./shared/package.js"
export * from "./text/output-truncation.js"
export * from "./tools/defineNativeTool.js"
export * from "./tools/ToolRepetitionDetector.js"
export * from "./transport/index.js"
export * from "./worktree/index.js"
export * from "./i18n/index.js"
// The default i18next instance for consumers that call `i18n.t(...)` directly.
export { default as i18n } from "./i18n/index.js"
