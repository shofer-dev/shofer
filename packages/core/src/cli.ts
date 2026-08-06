/**
 * Cli-safe exports for the core package.
 */

export * from "./debug-log/index.js"
export {
	type ParsedApiReqStartedTextType,
	consolidateTokenUsage,
	hasTokenUsageChanged,
	hasToolUsageChanged,
	consolidateApiRequests,
	consolidateCommands,
	COMMAND_OUTPUT_STRING,
	safeJsonParse,
} from "@shofer/types"
export * from "./task-history/index.js"

// The layered `.shofer/` configuration surface. The CLI host must be able to ask
// what the node's own config already decides before it seeds any default of its
// own (see `apps/cli/src/agent/approval-posture.ts`); reading the scope files here
// rather than re-implementing them is what keeps the CLI's answer identical to the
// extension host's `ContextProxy` overlay.
export {
	loadLayeredOverlay,
	loadLayeredScopes,
	readScopeSettingsFile,
	SCOPE_SETTINGS_FILE,
} from "./config/layered-settings-file.js"
export { resolveScopeRoots, type ScopeRootInputs, type ScopeRoots } from "./config/scope-roots.js"
export {
	isPathLocked,
	type LayeredConfigInput,
	type LayeredSettings,
	type LockedManifest,
} from "./config/layered-config.js"

// Plugin distribution surface (design §9; Phase 5) — the `shofer plugin` CLI commands
// pack/install/list/remove plugins through these.
export * from "./plugins/plugin-pack.js"
export {
	PluginManager,
	createNodePluginFs,
	type DiscoveredPlugin,
	type PluginDir,
	type PluginFsHost,
	type PluginStateStore,
} from "./plugins/plugin-manager.js"
