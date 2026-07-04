import { z } from "zod"

import type { CustomToolDefinition } from "./custom-tool.js"
import { modeConfigObjectSchema } from "./mode.js"

/**
 * Typed plugin API (v3 architecture §10).
 *
 * shofer's existing extensibility centers on the marketplace (data items) and the
 * custom-tool registry (tools only). A plugin generalizes that: a typed object
 * with optional **hooks** that can register tools, transform the system prompt,
 * and observe events — so third parties can extend *behavior*, not just add data.
 *
 * Hooks are all optional and host-agnostic (no `vscode` types), so plugins run in
 * any host (extension, CLI, future server). Distribution stays the marketplace's
 * job; this is the substrate it curates over.
 *
 * This is the contract; `PluginRegistry` (in `@shofer/core`) collects plugins and
 * runs the hooks at the right points. Wiring the registry into the live
 * system-prompt / tool-assembly / event paths is the strangler follow-on.
 */
export interface ShoferPlugin {
	/** Unique plugin name (used for ordering, logging, dedupe). */
	readonly name: string

	/** Called once when the plugin is registered. */
	initialize?(context: PluginContext): void | Promise<void>

	/**
	 * Contribute native/custom tools. Returned definitions are added to the tool
	 * set the model sees (subject to the usual permission/mode gating).
	 */
	registerTools?(context: PluginContext): CustomToolDefinition[] | Promise<CustomToolDefinition[]>

	/**
	 * Transform the system prompt before it is sent. Plugins run in registration
	 * order, each receiving the previous plugin's output.
	 */
	transformSystemPrompt?(prompt: string, context: PluginContext): string | Promise<string>

	/** Observe telemetry/lifecycle events (read-only; must not throw). */
	onEvent?(event: PluginEvent, context: PluginContext): void
}

/** Minimal, host-agnostic context handed to plugin hooks. */
export interface PluginContext {
	/** Absolute path of the active workspace, if any. */
	readonly workspacePath?: string
	/** Current mode slug. */
	readonly mode?: string
}

/** A lightweight event surfaced to `onEvent` (decoupled from the telemetry catalog). */
export interface PluginEvent {
	readonly name: string
	readonly properties?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Plugin manifest (`plugin.json`) — the declarative contract (design §5).
//
// The manifest is the single source of truth for what a plugin *declares*: its
// metadata, the `permissions` it requests (the security contract), and the
// `contributes` block (declarative modes/skills/commands/MCP servers/rules).
// The Zod schema below is validated fail-closed (`.strict()` at every level —
// unknown keys are rejected), mirroring how tool schemas are done. Phase 1 wires
// the *declarative* contributions; code hooks (`main`) land in Phase 2.
// ---------------------------------------------------------------------------

/**
 * UI regions a plugin may request to contribute components to (design §6.8).
 * Declared here so manifest validation is stable; the actual mounting is Phase 4.
 */
export const pluginUiRegionSchema = z.enum([
	"chat-input-toolbar",
	"task-header",
	"settings-tab",
	"chat-message-addon",
	"sidebar-panel",
])

export type PluginUiRegion = z.infer<typeof pluginUiRegionSchema>

/**
 * Permissions a plugin requests. Every capability defaults to *denied* — an
 * absent/false flag means Shofer will not surface that contribution. This block
 * is the security contract (design §5, §8): a contribution is only honored when
 * the matching permission is granted.
 */
export const pluginPermissionsSchema = z
	.object({
		tools: z.boolean().optional(),
		systemPrompt: z.boolean().optional(),
		modes: z.boolean().optional(),
		skills: z.boolean().optional(),
		commands: z.boolean().optional(),
		rules: z.boolean().optional(),
		mcpServers: z.boolean().optional(),
		/** UI regions the plugin wants to render into (Phase 4). */
		ui: z.array(pluginUiRegionSchema).optional(),
		lifecycle: z.boolean().optional(),
		events: z.boolean().optional(),
		/** Allowed network endpoints (host or origin prefixes). Enforced in Phase 2. */
		network: z.array(z.string()).optional(),
		/** Allowed filesystem paths (relative to the plugin/workspace). Enforced in Phase 2. */
		filesystem: z.array(z.string()).optional(),
	})
	.strict()

export type PluginPermissions = z.infer<typeof pluginPermissionsSchema>

/**
 * A mode a plugin contributes. Same shape as a `ModeConfig` object minus the
 * `source`/`pluginName` fields — those are assigned by the `PluginManager` at
 * discovery time (`source: "plugin"`, `pluginName: <name>`), not by the author.
 */
export const pluginModeContributionSchema = modeConfigObjectSchema
	.omit({ source: true, pluginName: true })
	.strict()
	.refine((data) => data.tools !== undefined || data.tools_allowed !== undefined, {
		message: "Either 'tools' or 'tools_allowed' must be provided",
	})

export type PluginModeContribution = z.infer<typeof pluginModeContributionSchema>

/**
 * A skill a plugin declares. The physical `SKILL.md` lives under the plugin's
 * `skills/` directory; this entry is the manifest-level declaration (design §6.4).
 */
export const pluginSkillContributionSchema = z
	.object({
		name: z.string().min(1),
		description: z.string().min(1),
	})
	.strict()

export type PluginSkillContribution = z.infer<typeof pluginSkillContributionSchema>

/**
 * A slash command a plugin declares. The physical `.md` lives under the plugin's
 * `commands/` directory; this entry is the manifest-level declaration (design §6.5).
 */
export const pluginCommandContributionSchema = z
	.object({
		name: z.string().min(1),
		description: z.string().optional(),
		argumentHint: z.string().optional(),
	})
	.strict()

export type PluginCommandContribution = z.infer<typeof pluginCommandContributionSchema>

/**
 * A rules markdown file a plugin ships, optionally scoped to specific modes
 * (design §6.7). `path` is relative to the plugin root.
 */
export const pluginRuleContributionSchema = z
	.object({
		path: z.string().min(1),
		modes: z.array(z.string()).optional(),
	})
	.strict()

export type PluginRuleContribution = z.infer<typeof pluginRuleContributionSchema>

/**
 * MCP server configs a plugin bundles (design §6.6 Mode A). Kept intentionally
 * loose here (`unknown` per-server config) — `@shofer/types` stays browser-safe
 * and `McpHub` re-validates each entry with its own `ServerConfigSchema` before
 * connecting. Keys are server names.
 */
export const pluginMcpServersSchema = z.record(z.string(), z.record(z.string(), z.unknown()))

export type PluginMcpServers = z.infer<typeof pluginMcpServersSchema>

/** The declarative `contributes` block (design §5, §6). All entries optional. */
export const pluginContributesSchema = z
	.object({
		modes: z.array(pluginModeContributionSchema).optional(),
		skills: z.array(pluginSkillContributionSchema).optional(),
		commands: z.array(pluginCommandContributionSchema).optional(),
		mcpServers: pluginMcpServersSchema.optional(),
		rules: z.array(pluginRuleContributionSchema).optional(),
	})
	.strict()

export type PluginContributes = z.infer<typeof pluginContributesSchema>

/**
 * The `plugin.json` manifest schema (design §5). Validated fail-closed: unknown
 * top-level and nested keys are rejected. `main` is `null`/absent for purely
 * declarative plugins (Phase 1's target).
 */
export const pluginManifestSchema = z
	.object({
		/** Unique plugin id — used for ordering, dedupe, namespacing, and state keys. */
		name: z
			.string()
			.min(1)
			.regex(
				/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
				"Plugin name must start with a letter/number and contain only letters, numbers, '.', '_', or '-'",
			),
		version: z.string().min(1),
		/**
		 * Semver of the Shofer plugin API surface this plugin targets (design §14.2).
		 * Lets Shofer refuse/migrate plugins built against an incompatible API. Not
		 * enforced in Phase 1 (declarative-only), but part of the contract from day one.
		 */
		shoferPluginApiVersion: z.string().optional(),
		description: z.string().optional(),
		author: z.string().optional(),
		homepage: z.string().optional(),
		license: z.string().optional(),
		/** Minimum Shofer version required (semver range). Not enforced in Phase 1. */
		shoferVersion: z.string().optional(),
		/**
		 * Entry point relative to the plugin dir. `null`/absent ⇒ purely declarative
		 * (no code hooks). Code loading is Phase 2.
		 */
		main: z.string().nullable().optional(),
		permissions: pluginPermissionsSchema.optional(),
		contributes: pluginContributesSchema.optional(),
		/** Other plugins that must be installed. Not enforced in Phase 1. */
		dependencies: z.array(z.string()).optional(),
		/** JSON-schema-ish description of user-configurable settings (Phase 2). */
		config: z.record(z.string(), z.unknown()).optional(),
	})
	.strict()

export type PluginManifest = z.infer<typeof pluginManifestSchema>

// ---------------------------------------------------------------------------
// UI-facing plugin types (Settings → Plugins tab, design §12)
// ---------------------------------------------------------------------------

/** Per-kind counts of a plugin's declarative contributions (for the UI summary). */
export interface PluginContributionSummary {
	modes: number
	skills: number
	commands: number
	mcpServers: number
	rules: number
}

/** A discovered plugin as shown in the Plugins settings tab (no secrets). */
export interface PluginView {
	name: string
	version: string
	description?: string
	scope: "global" | "project"
	/** The user's persisted toggle intent (design §7). */
	enabled: boolean
	/**
	 * Why an enabled plugin is nonetheless inactive — an unmet/missing/cyclic
	 * dependency (design §14.3 — fail-closed). Present only when {@link enabled} is
	 * `true` but the plugin's contributions are suppressed, so the panel can show
	 * the user *why* the toggle is on yet nothing registered. Unset when the plugin
	 * is active or disabled by the user.
	 */
	disabledReason?: string
	/** Whether the plugin ships a code entry point (`main`). Not loaded in Phase 1. */
	hasCode: boolean
	contributionCounts: PluginContributionSummary
}

/** Snapshot of discovered plugins pushed to the webview (`ExtensionMessage.plugins`). */
export interface PluginsState {
	plugins: PluginView[]
}

/** Webview → extension request (carried in `WebviewMessage.plugin`). */
export type PluginRequest =
	| { action: "list" }
	| { action: "setEnabled"; name: string; enabled: boolean }
