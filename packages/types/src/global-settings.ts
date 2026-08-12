import { z } from "zod"

import { type Keys } from "./type-fu.js"
import {
	type ProviderSettings,
	PROVIDER_SETTINGS_KEYS,
	providerSettingsEntrySchema,
	providerSettingsSchema,
} from "./provider-settings.js"
import { historyItemSchema, costLimitSchema } from "./history.js"
import { experimentsSchema } from "./experiment.js"
import { telemetrySettingsSchema } from "./telemetry.js"
import { modeConfigSchema } from "./mode.js"
import { customModePromptsSchema, customSupportPromptsSchema } from "./mode.js"
import { toolNamesSchema } from "./tool.js"
import { languagesSchema } from "./vscode.js"

/**
 * Default delay in milliseconds after writes to allow diagnostics to detect potential problems.
 * This delay is particularly important for Go and other languages where tools like goimports
 * need time to automatically clean up unused imports.
 */
export const DEFAULT_WRITE_DELAY_MS = 1000

/**
 * Terminal output preview size options for persisted command output.
 *
 * Controls how much command output is kept in memory as a "preview" before
 * the LLM decides to retrieve more via `read_command_output`. Larger previews
 * mean more immediate context but consume more of the context window.
 *
 * - `small`: 5KB preview - Best for long-running commands with verbose output
 * - `medium`: 10KB preview - Balanced default for most use cases
 * - `large`: 20KB preview - Best when commands produce critical info early
 *
 * @see OutputInterceptor - Uses this setting to determine when to spill to disk
 * @see PersistedCommandOutput - Contains the resulting preview and artifact reference
 */
export type TerminalOutputPreviewSize = "small" | "medium" | "large"

/**
 * Byte limits for each terminal output preview size.
 *
 * Maps preview size names to their corresponding byte thresholds.
 * When command output exceeds these thresholds, the excess is persisted
 * to disk and made available via the `read_command_output` tool.
 */
export const TERMINAL_PREVIEW_BYTES: Record<TerminalOutputPreviewSize, number> = {
	small: 5 * 1024, // 5KB
	medium: 10 * 1024, // 10KB
	large: 20 * 1024, // 20KB
}

/**
 * Default terminal output preview size.
 * The "medium" (10KB) setting provides a good balance between immediate
 * visibility and context window conservation for most use cases.
 */
export const DEFAULT_TERMINAL_OUTPUT_PREVIEW_SIZE: TerminalOutputPreviewSize = "medium"

/**
 * GlobalSettings
 */

export const globalSettingsSchema = z.object({
	currentApiConfigName: z.string().optional(),
	listApiConfigMeta: z.array(providerSettingsEntrySchema).optional(),
	pinnedApiConfigs: z.record(z.string(), z.boolean()).optional(),

	lastShownAnnouncementId: z.string().optional(),
	customInstructions: z.string().optional(),
	taskHistory: z.array(historyItemSchema).optional(),
	dismissedUpsells: z.array(z.string()).optional(),

	// Image generation settings (experimental) - flattened for simplicity
	imageGenerationProvider: z.enum(["openrouter"]).optional(),
	openRouterImageApiKey: z.string().optional(),
	openRouterImageGenerationSelectedModel: z.string().optional(),

	customCondensingPrompt: z.string().optional(),

	autoApprovalEnabled: z.boolean().optional(),
	alwaysAllowReadOnly: z.boolean().optional(),
	alwaysAllowReadOnlyOutsideWorkspace: z.boolean().optional(),
	alwaysAllowWrite: z.boolean().optional(),
	alwaysAllowWriteOutsideWorkspace: z.boolean().optional(),
	alwaysAllowWriteProtected: z.boolean().optional(),
	alwaysAllowBrowser: z.boolean().optional(),
	writeDelayMs: z.number().min(0).optional(),
	requestDelaySeconds: z.number().optional(),
	/**
	 * Ceiling on CONSECUTIVE failed model API requests before a task gives up and
	 * surfaces the provider's error. Counts only failures with no successful
	 * request in between; a value below 1 falls back to the default (6), because
	 * "unlimited" is the defect this bound removes — an unreachable provider
	 * otherwise retries behind an exponential backoff for hours and presents as a
	 * hang.
	 */
	maxConsecutiveApiFailures: z.number().int().min(1).optional(),
	alwaysAllowMcp: z.boolean().optional(),
	alwaysAllowUncategorized: z.boolean().optional(),
	alwaysAllowModeSwitch: z.boolean().optional(),
	alwaysAllowSubtasks: z.boolean().optional(),
	alwaysAllowExecute: z.boolean().optional(),
	alwaysAllowFollowupQuestions: z.boolean().optional(),
	followupAutoApproveTimeoutMs: z.number().optional(),
	allowedCommands: z.array(z.string()).optional(),
	deniedCommands: z.array(z.string()).optional(),
	allowedReadPaths: z.array(z.string()).optional(),
	allowedWritePaths: z.array(z.string()).optional(),
	commandExecutionTimeout: z.number().optional(),
	commandTimeoutAllowlist: z.array(z.string()).optional(),
	preventCompletionWithOpenTodos: z.boolean().optional(),
	/** Which `.shofer/` scope Settings writes persist to (default: the user scope). */
	settingsWriteScope: z.enum(["user", "project"]).optional(),
	// Migrated from `shofer.*` VS Code config into ContextProxy/globalState — the
	// single source of truth (todos/config-cleanup.md Part A). The `package.json`
	// `contributes.configuration` rows are removed as each consumer is repointed.
	newTaskRequireTodos: z.boolean().optional(),
	enableCodeActions: z.boolean().optional(),
	maximumIndexedFilesForFileSearch: z.number().optional(),
	apiRequestTimeout: z.number().optional(),
	vsCodeLmModelSelector: z.object({ vendor: z.string().optional(), family: z.string().optional() }).optional(),
	debug: z.boolean().optional(),
	debugProxyEnabled: z.boolean().optional(),
	debugProxyServerUrl: z.string().optional(),
	debugProxyTlsInsecure: z.boolean().optional(),
	allowedMaxRequests: z.number().nullish(),
	allowedMaxCost: z.number().nullish(),
	autoCondenseContext: z.boolean().optional(),
	autoCondenseContextPercent: z.number().optional(),

	/**
	 * Whether to include current time in the environment details
	 * @default true
	 */
	includeCurrentTime: z.boolean().optional(),
	/**
	 * Whether to include current cost in the environment details
	 * @default true
	 */
	includeCurrentCost: z.boolean().optional(),
	/**
	 * Maximum number of git status file entries to include in the environment details.
	 * Set to 0 to disable git status. The header (branch, commits) is always included when > 0.
	 * @default 0
	 */
	maxGitStatusFiles: z.number().optional(),

	/**
	 * Whether to include diagnostic messages (errors, warnings) in tool outputs
	 * @default true
	 */
	includeDiagnosticMessages: z.boolean().optional(),
	/**
	 * Maximum number of diagnostic messages to include in tool outputs
	 * @default 50
	 */
	maxDiagnosticMessages: z.number().optional(),

	ttsEnabled: z.boolean().optional(),
	ttsSpeed: z.number().optional(),
	soundEnabled: z.boolean().optional(),
	soundVolume: z.number().optional(),

	maxOpenTabsContext: z.number().optional(),
	maxWorkspaceFiles: z.number().optional(),
	showShoferIgnoredFiles: z.boolean().optional(),
	enableSubfolderRules: z.boolean().optional(),
	useAgentRules: z.boolean().optional(),
	maxImageFileSize: z.number().optional(),
	maxTotalImageSize: z.number().optional(),

	terminalOutputPreviewSize: z.enum(["small", "medium", "large"]).optional(),
	terminalShellIntegrationTimeout: z.number().optional(),
	terminalShellIntegrationDisabled: z.boolean().optional(),
	terminalCommandDelay: z.number().optional(),
	terminalPowershellCounter: z.boolean().optional(),
	terminalZshClearEolMark: z.boolean().optional(),
	terminalZshOhMy: z.boolean().optional(),
	terminalZshP10k: z.boolean().optional(),
	terminalZdotdir: z.boolean().optional(),
	execaShellPath: z.string().optional(),

	diagnosticsEnabled: z.boolean().optional(),

	rateLimitSeconds: z.number().optional(),
	experiments: experimentsSchema.optional(),

	language: languagesSchema.optional(),

	telemetrySetting: telemetrySettingsSchema.optional(),

	mcpEnabled: z.boolean().optional(),

	mode: z.string().optional(),
	customModes: z.array(modeConfigSchema).optional(),
	customModePrompts: customModePromptsSchema.optional(),
	customSupportPrompts: customSupportPromptsSchema.optional(),
	enhancementApiConfigId: z.string().optional(),
	includeTaskHistoryInEnhance: z.boolean().optional(),
	historyPreviewCollapsed: z.boolean().optional(),
	reasoningBlockCollapsed: z.boolean().optional(),
	/**
	 * Controls the keyboard behavior for sending messages in the chat input.
	 * - "send": Enter sends message, Shift+Enter creates newline (default)
	 * - "newline": Enter creates newline, Shift+Enter/Ctrl+Enter sends message
	 * @default "send"
	 */
	enterBehavior: z.enum(["send", "newline"]).optional(),
	profileThresholds: z.record(z.string(), z.number()).optional(),
	hasOpenedModeSelector: z.boolean().optional(),
	lastModeExportPath: z.string().optional(),
	lastModeImportPath: z.string().optional(),
	lastSettingsExportPath: z.string().optional(),
	lastTaskExportPath: z.string().optional(),
	lastImageSavePath: z.string().optional(),

	/**
	 * List of native tool names to globally disable.
	 * Tools in this list will be excluded from prompt generation and rejected at execution time.
	 */
	disabledTools: z.array(toolNamesSchema).optional(),

	/**
	 * Default per-root-task cost limit for new tasks.
	 * When maxUsd is 0 or unset, cost limiting is disabled.
	 * The action field controls behaviour when the limit is exceeded.
	 * @default { maxUsd: 0, action: "pause" }
	 */
	defaultCostLimit: costLimitSchema.nullish(),

	/**
	 * Number of days an archived task is retained before the periodic cleanup
	 * permanently deletes it (see ShoferProvider.scheduleArchivedCleanup).
	 * - unset / null  → default of 7 days (preserves legacy behaviour)
	 * - 0             → never auto-delete (keep archived tasks forever)
	 * - N > 0         → retain for N days after the task was archived
	 */
	archivedTaskRetentionDays: z.number().int().min(0).nullish(),

	/**
	 * Maximum number of parallel (non-terminal, non-idle) tasks allowed globally.
	 * When the number of running/waiting tasks reaches this limit, new_task
	 * returns an error asking the caller to wait and retry or accomplish the
	 * work through other means. Set to 0 for unlimited.
	 * @default 10
	 */
	maxParallelTasks: z.number().int().min(0).nullish(),

	/**
	 * Enable integration with the Shofer LLM Model Provider extension
	 * (shofer.llm.getModelPricing, shofer.llm.getRequestCost, etc.).
	 * When disabled (default), the vscode-lm provider uses only the
	 * information available from the VS Code LM API itself — token counts
	 * but no USD pricing. When enabled, it queries the llm-provider
	 * extension for per-token rates and per-conversation cost ledgers,
	 * which are required for cost-limit enforcement to work.
	 * @default false
	 */
	enableLlmProviderIntegration: z.boolean().optional(),

	/**
	 * Maximum inline byte length of a tool result / message text stored in
	 * `shoferMessages` and `apiConversationHistory`. Larger payloads are
	 * externalised to `<taskDir>/blobs/<sha256>.txt` and replaced with a
	 * `<shofer-blob ... />` reference token. Set to 0 to disable
	 * externalisation entirely. See §4.3 of `docs/mem-utilization-profiling.md`.
	 * @default 2048
	 */
	shoferBlobCapBytes: z.number().int().min(0).optional(),

	/**
	 * Maximum number of bytes of an MCP tool response that is forwarded to
	 * the LLM as text. Larger responses are truncated to this size and a
	 * truncation banner is appended so the agent knows the cut-off happened.
	 * Caps the worst-case "MCP server returned 50 MiB of HTML" footgun. Set
	 * to 0 to disable truncation. See §4.7 of `docs/mem-utilization-profiling.md`.
	 * @default 1048576 (1 MiB)
	 */
	shoferMcpMaxResponseBytes: z.number().int().min(0).optional(),

	/**
	 * Minimum log level for the extension's output channel logger.
	 * Log entries below this threshold are silently dropped.
	 * @default "info"
	 */
	logLevel: z.enum(["debug", "info", "warn", "error", "fatal"]).optional(),

	/**
	 * Whitelist of log categories (ctx identifiers) to display.
	 * When undefined or empty, all categories are shown.
	 * @default undefined (all categories)
	 */
	logCategories: z.array(z.string()).optional(),

	// ─── Captcha Solver ───────────────────────────────────────────────────
	// Tuning knobs for the captcha-solver sub-task's retry/round budget and
	// overall wall-clock timeout. Consumed by the captcha-solver mode's
	// customInstructions and any agent-level orchestration that enforces the
	// budget. See extensions/docs/captcha-solver.md for the full design.
	/**
	 * Maximum solve attempts per round before the solver returns "failed".
	 * A round is one challenge presentation (e.g. one hCaptcha image grid).
	 * @default 3
	 */
	captchaSolverMaxAttempts: z.number().int().min(1).optional(),
	/**
	 * Maximum challenge rounds for multi-round captchas (hCaptcha, Arkose)
	 * before the solver returns "failed".
	 * @default 3
	 */
	captchaSolverMaxRounds: z.number().int().min(1).optional(),
	/**
	 * Overall timeout in seconds for a single solve operation (all rounds).
	 * The solver sub-task must return (solved/failed/unsolvable) before this.
	 * @default 120
	 */
	captchaSolverTimeoutSec: z.number().int().min(10).optional(),

	/**
	 * Per-plugin user-configured settings, keyed by plugin name (plugin system
	 * design §5 `config` schema / §6.2 `PluginContext.config`). Each entry is the
	 * plugin's own config object; the plugin's manifest declares the shape and
	 * defaults, and the PluginManager merges defaults over the stored values before
	 * injecting the result into the plugin's `PluginContext.config`. Persisted/read
	 * via `ContextProxy` in globalState (design §12 Settings → Plugins).
	 * @default undefined (no plugin has configured settings)
	 */
	pluginConfigs: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
})

export type GlobalSettings = z.infer<typeof globalSettingsSchema>

export const GLOBAL_SETTINGS_KEYS = globalSettingsSchema.keyof().options

/**
 * ShoferSettings
 */

export const shoferSettingsSchema = providerSettingsSchema.merge(globalSettingsSchema)

export type ShoferSettings = GlobalSettings & ProviderSettings

/**
 * SecretState
 */
export const SECRET_STATE_KEYS = [
	"apiKey",
	"openRouterApiKey",
	"awsAccessKey",
	"awsApiKey",
	"awsSecretKey",
	"awsSessionToken",
	"openAiApiKey",
	"ollamaApiKey",
	"geminiApiKey",
	"openAiNativeApiKey",
	"deepSeekApiKey",
	"moonshotApiKey",
	"dashScopeApiKey",
	"mistralApiKey",
	"minimaxApiKey",
	"requestyApiKey",
	"unboundApiKey",
	"xaiApiKey",
	"xiaomiApiKey",
	"litellmApiKey",
	"sambaNovaApiKey",
	"zaiApiKey",
	"fireworksApiKey",
	"vercelAiGatewayApiKey",
	"basetenApiKey",
] as const

// Global secrets that are part of GlobalSettings (not ProviderSettings)
export const GLOBAL_SECRET_KEYS = [
	"openRouterImageApiKey", // For image generation
	/**
	 * Every plugin's secret config values, as one JSON blob
	 * (`{ [plugin]: { [key]: value } }`).
	 *
	 * A plugin declares a config property `secret: true` and the host routes it here
	 * instead of into `pluginConfigs` (plain `globalState`, and echoed to the webview):
	 * an embedding-provider key or a vector-store token belongs in the OS keychain like
	 * every other credential. One blob rather than a key per plugin property because
	 * `SecretState` is a fixed, typed key set — a plugin cannot add to it, and should not
	 * be able to.
	 */
	"pluginSecrets",
] as const

// Type for the actual secret storage keys
type ProviderSecretKey = (typeof SECRET_STATE_KEYS)[number]
type GlobalSecretKey = (typeof GLOBAL_SECRET_KEYS)[number]

// Type representing all secrets that can be stored
export type SecretState = Pick<ProviderSettings, Extract<ProviderSecretKey, keyof ProviderSettings>> & {
	[K in GlobalSecretKey]?: string
}

export const isSecretStateKey = (key: string): key is Keys<SecretState> =>
	SECRET_STATE_KEYS.includes(key as ProviderSecretKey) || GLOBAL_SECRET_KEYS.includes(key as GlobalSecretKey)

/**
 * Provider-profile secret keys — the per-profile LLM credentials whose sole
 * persisted store is the provider-profiles blob (`shofer_config_api_config`,
 * managed by `ProviderSettingsManager`). This is exactly `SECRET_STATE_KEYS`:
 * every provider API key.
 *
 * These keys are NOT written to individual `SecretStorage` entries. `ContextProxy`'s
 * `secretCache` holds only the *current* profile's copy in memory, sourced from the
 * blob on activation (the profile object carries the values) and on restart (loaded
 * from the blob for the live-profile marker). Contrast the secrets that DO keep
 * their own `SecretStorage` entries: the `GLOBAL_SECRET_KEYS`
 * (`openRouterImageApiKey`, `pluginSecrets`) — GlobalSettings secrets absent from
 * `providerSettingsSchema`, so they cannot live in a profile.
 */
export const PROFILE_SECRET_KEYS = [...SECRET_STATE_KEYS]

/** A per-profile LLM credential whose source of truth is the profiles blob. */
export type ProfileSecretKey = (typeof PROFILE_SECRET_KEYS)[number]

/** True for a per-profile LLM credential whose SoT is the profiles blob (see `PROFILE_SECRET_KEYS`). */
export const isProfileSecretKey = (key: string): key is ProfileSecretKey =>
	(PROFILE_SECRET_KEYS as readonly string[]).includes(key)

/**
 * GlobalState
 */

export type GlobalState = Omit<ShoferSettings, Keys<SecretState>>

export const GLOBAL_STATE_KEYS = [...GLOBAL_SETTINGS_KEYS, ...PROVIDER_SETTINGS_KEYS].filter(
	(key: Keys<ShoferSettings>) => !isSecretStateKey(key),
) as Keys<GlobalState>[]

export const isGlobalStateKey = (key: string): key is Keys<GlobalState> =>
	GLOBAL_STATE_KEYS.includes(key as Keys<GlobalState>)

/**
 * Evals
 */

// Default settings when running evals (unless overridden).
export const EVALS_SETTINGS: ShoferSettings = {
	apiProvider: "openrouter",

	lastShownAnnouncementId: "jul-09-2025-3-23-0",

	pinnedApiConfigs: {},

	autoApprovalEnabled: true,
	alwaysAllowReadOnly: true,
	alwaysAllowReadOnlyOutsideWorkspace: false,
	alwaysAllowWrite: true,
	alwaysAllowWriteOutsideWorkspace: false,
	alwaysAllowWriteProtected: false,
	alwaysAllowBrowser: false,
	writeDelayMs: 1000,
	requestDelaySeconds: 10,
	alwaysAllowMcp: true,
	alwaysAllowModeSwitch: true,
	alwaysAllowSubtasks: true,
	alwaysAllowExecute: true,
	alwaysAllowFollowupQuestions: true,
	followupAutoApproveTimeoutMs: 0,
	allowedCommands: ["*"],
	commandExecutionTimeout: 20,
	commandTimeoutAllowlist: [],
	preventCompletionWithOpenTodos: false,

	ttsEnabled: false,
	ttsSpeed: 1,
	soundEnabled: false,
	soundVolume: 0.5,

	terminalShellIntegrationTimeout: 30000,
	terminalCommandDelay: 0,
	terminalPowershellCounter: false,
	terminalZshOhMy: true,
	terminalZshClearEolMark: true,
	terminalZshP10k: false,
	terminalZdotdir: true,
	terminalShellIntegrationDisabled: true,

	diagnosticsEnabled: true,

	rateLimitSeconds: 0,
	maxOpenTabsContext: 20,
	maxWorkspaceFiles: 200,
	maxGitStatusFiles: 20,
	showShoferIgnoredFiles: true,

	includeDiagnosticMessages: true,
	maxDiagnosticMessages: 50,

	language: "en",
	telemetrySetting: "enabled",

	mcpEnabled: false,

	mode: "code", // "architect",

	customModes: [],
}

export const EVALS_TIMEOUT = 5 * 60 * 1_000
