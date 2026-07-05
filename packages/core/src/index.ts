export * from "./constants.js"
export * from "./blob-store/BlobStore.js"
export * from "./checkpoints/index.js"
export * from "./services/glob/list-files.js"
export * from "./services/shofer-config/index.js"
export * from "./services/glob/constants.js"
export * from "./services/glob/ignore-utils.js"
export * from "./services/live-memory/context-window.js"
export * from "./services/live-memory/conversation-store.js"
export * from "./services/live-memory/directory-tree.js"
export * from "./services/live-memory/pricing.js"
export * from "./services/live-memory/question-queue.js"
export * from "./services/live-memory/llm-client.js"
// Category II manager registries (Task-cluster Chunk B) — host-agnostic seams the
// core-resident tools / FileContextTracker use to reach the VS Code `src` managers.
export * from "./services/live-memory/live-memory-registry.js"
export * from "./services/code-index/code-index-registry.js"
export * from "./services/git-index/git-index-registry.js"
export * from "./services/skills/skills-registry.js"
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
export * from "./plugins/plugin-manager.js"
export * from "./plugins/plugin-loader.js"
export * from "./plugins/plugin-pack.js"
export * from "./plugins/plugin-sandbox.js"
export * from "./plugins/plugin-ai.js"
export * from "./plugins/plugin-agent.js"
export * from "./plugins/plugin-search.js"
export * from "./plugins/plugin-storage.js"
export * from "./plugins/plugin-services.js"
export * from "./plugins/ui-registry.js"
export * from "./api/fetchers-cache-dir.js"
export * from "./api/index.js"
export * from "./api/native-handler-registry.js"
export * from "./api/providers/index.js"
export { getOpenAiModels } from "./api/providers/openai.js"
export { getModels, getModelsFromCache, flushModels } from "./api/providers/fetchers/modelCache.js"
export { forceFullModelDetailsLoad, hasLoadedFullDetails } from "./api/providers/fetchers/lmstudio.js"
export { handleOpenAIError } from "./api/providers/utils/openai-error-handler.js"
export * from "./api/providers/utils/retryable-error.js"
export * from "./api/transform/stream.js"
export * from "./api/transform/openai-format.js"
export * from "./api/transform/anthropic-filter.js"
export * from "./api/transform/bedrock-converse-format.js"
export * from "./api/transform/gemini-format.js"
export * from "./api/transform/image-cleaning.js"
export * from "./api/transform/minimax-format.js"
export * from "./api/transform/mistral-format.js"
export * from "./api/transform/model-params.js"
export * from "./api/transform/r1-format.js"
export * from "./api/transform/reasoning.js"
export * from "./api/transform/reasoning-preamble.js"
export * from "./api/transform/responses-api-input.js"
export * from "./api/transform/responses-api-stream.js"
export * from "./api/transform/ai-sdk.js"
export * from "./api/transform/zai-format.js"
export * from "./api/transform/caching/index.js"
export * from "./api/transform/cache-strategy/index.js"
export * from "./prompts/tools/native-tools/converters.js"
export * from "./prompts/tools/native-tools/index.js"
export * from "./prompts/tools/native-tools/read_file.js"
export * from "./task/subtask-limits.js"
export * from "./diff/stats.js"
export * from "./diff/strategies/multi-search-replace.js"
export * from "./prompts/sections/capabilities.js"
export * from "./prompts/sections/objective.js"
export * from "./prompts/sections/markdown-formatting.js"
export * from "./prompts/sections/tool-use.js"
export * from "./prompts/sections/tool-use-guidelines.js"
export * from "./prompts/sections/rules.js"
export * from "./prompts/sections/system-info.js"
export * from "./prompts/sections/modes.js"
export * from "./prompts/sections/skills.js"
export * from "./prompts/sections/live-memory.js"
export * from "./prompts/sections/custom-instructions.js"
export * from "./prompts/system.js"
export * from "./prompts/tools/filter-tools-for-mode.js"
export * from "./condense/index.js"
export * from "./context-management/index.js"
export { REQUESTY_BASE_URL, toRequestyServiceUrl } from "@shofer/types"
export * from "./utils/outputChannel.js"
export * from "./utils/outputChannelLogger.js"
export * from "./utils/safeWriteJson.js"
export * from "./utils/errors.js"
export * from "./utils/commands.js"
export * from "./integrations/misc/extract-text-from-xlsx.js"
export * from "./integrations/misc/extract-text.js"
export * from "./integrations/misc/indentation-reader.js"
export * from "./utils/pathUtils.js"
export * from "./utils/config.js"
export * from "./tools/helpers/toolResultFormatting.js"
export * from "./tools/helpers/imageHelpers.js"
export * from "./tools/helpers/searchCap.js"
export * from "./tools/helpers/toolInputParsing.js"
export * from "./utils/tool-id.js"
export * from "./utils/text-normalization.js"
export * from "./utils/perf.js"
export * from "./utils/tag-matcher.js"
export * from "./utils/tiktoken.js"
export * from "./utils/token-counter.js"
export * from "./utils/worker-schemas.js"
export * from "./utils/mcp-name.js"
export * from "./utils/json-schema.js"
export * from "./utils/storage.js"
export * from "./utils/object.js"
export * from "./utils/git.js"
export * from "./utils/git-submodules.js"
export * from "./environment/reminder.js"
export * from "./prompts/types.js"
export * from "./context/context-management/context-error-handling.js"
export * from "./message-queue/MessageQueueService.js"
export * from "./task/AskIgnoredError.js"
export * from "./task/findToolName.js"
export * from "./task/validateToolResultIds.js"
export * from "./task/mergeConsecutiveApiMessages.js"
export * from "./task-persistence/message-store.js"
export * from "./task-persistence/apiMessages.js"
export * from "./task-persistence/taskMessages.js"
export * from "./task-persistence/PersistencePort.js"
export { taskMetadata } from "./task-persistence/taskMetadata.js"
export * from "./prompts/responses.js"
export * from "./protect/ShoferProtectedController.js"
export * from "./webview/aggregateTaskCosts.js"
export * from "./workflow/index.js"
export * from "./auto-approval/commands.js"
// tree-sitter code-definition parsing (portable, wasm-backed). Public surface:
// parseSourceCodeDefinitionsForFile / extensions / get|setMinComponentLines (index)
// and LanguageParser / loadRequiredLanguageParsers (languageParser).
export * from "./services/tree-sitter/index.js"
export * from "./services/tree-sitter/languageParser.js"
export * from "./services/tree-sitter/markdownParser.js"
export * from "./auto-approval/index.js"
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
// Portable code-index engine (embedders / interfaces / vector-store / parser).
export * from "./services/code-index/index.js"
// Embedding model profiles (browser-safe data + helpers) used by the code-index engine.
export * from "./shared/embeddingModels.js"
export * from "./services/mcp/McpHub.js"
export * from "./services/mcp/mcp-hub-factory.js"
// mcpLogger re-exports only `setMcpOutputChannel`; its `mcpLog` symbol would
// collide with the `mcpLog` logger already exported from ./logging/subsystems.js.
export { setMcpOutputChannel } from "./services/mcp/mcpLogger.js"
export * from "./terminal/index.js"
export * from "./shared/package.js"
export * from "./shared/globalFileNames.js"
export * from "./text/output-truncation.js"
export * from "./assistant-message/NativeToolCallParser.js"
export * from "./assistant-message/types.js"
export * from "./tools/apply-patch/index.js"
export * from "./tools/defineNativeTool.js"
export * from "./tools/tool-aliases.js"
export * from "./tools/private-tool-registry.js"
export * from "./tools/ToolRepetitionDetector.js"
export * from "./transport/index.js"
export * from "./worktree/index.js"
export * from "./i18n/index.js"
// The default i18next instance for consumers that call `i18n.t(...)` directly.
export { default as i18n } from "./i18n/index.js"
// Host-agnostic leaves relocated from the VS Code `src` tree (Task-cluster A.3-2).
export * from "./utils/shell.js"
export * from "./services/skills/skillInvocation.js"
export * from "./tools/validateToolUse.js"
export * from "./context-tracking/FileContextTrackerTypes.js"
// Slash-command loader/service. NOTE: the loader's `getCommand(cwd, name)` collides
// with the VS Code command-id builder `getCommand(id)` already exported from
// ./utils/commands.js — re-export it here aliased as `getSlashCommand`.
export {
	getCommand as getSlashCommand,
	getCommands,
	getCommandNames,
	getCommandNameFromFile,
	isMarkdownFile,
	type Command,
} from "./services/command/commands.js"
export { getBuiltInCommands, getBuiltInCommand, getBuiltInCommandNames } from "./services/command/built-in-commands.js"

// ── Task-cluster Chunk C: the relocated agent-loop strongly-connected component ──
// Task + build-tools + the 56 tools + presentAssistantMessage + getEnvironmentDetails
// + FileContextTracker + mentions + ChangedFilesService + message-manager +
// getFullModeDetails. These now live in @shofer/core; the barrel surfaces them for
// the VS Code `src` consumers (ShoferProvider / TaskManager / workflow / webview).
export * from "./task/Task.js"
export * from "./task/build-tools.js"
export * from "./tools/index.js"
export * from "./assistant-message/presentAssistantMessage.js"
export * from "./environment/getEnvironmentDetails.js"
export * from "./context-tracking/FileContextTracker.js"
export * from "./file-changes/ChangedFilesService.js"
export * from "./message-manager/index.js"
export * from "./mentions/index.js"
export * from "./mentions/resolveImageMentions.js"
export * from "./modes/getFullModeDetails.js"
