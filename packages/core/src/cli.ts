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
export { getGlobalShoferDirectory } from "./services/shofer-config/index.js"
