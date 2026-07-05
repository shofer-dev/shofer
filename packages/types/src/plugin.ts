import { z } from "zod"

import type { CustomToolDefinition } from "./custom-tool.js"
import type { HostDisposable, HostEnv, HostFileSystem, Notifier } from "./host.js"
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

	/**
	 * Task/tool **lifecycle hooks** (design §6.9). Only honored for a plugin whose
	 * manifest grants `permissions.lifecycle`; the registry filters on that grant so
	 * an ungranted plugin's hooks never fire. Every hook is run behind the shared
	 * per-hook 500ms timeout and per-plugin error isolation (owner decision #8): a
	 * slow or throwing hook is skipped with a shown+logged warning and can never
	 * crash or stall the agent loop.
	 */
	lifecycle?: LifecycleHooks

	/**
	 * Receive a message from this plugin's UI component(s) over the scoped plugin-UI
	 * channel (design §6.8, Phase 4). The extension routes only messages addressed to
	 * this plugin (namespaced by plugin name), so a plugin can neither observe nor
	 * spoof another's channel. Observer-style: the return value is ignored and it must
	 * not throw (the registry isolates and warns on a throw). A plugin pushes back *to*
	 * its UI via the host-side sender (`ShoferProvider.postPluginUiMessage`).
	 */
	onUiMessage?(message: unknown, context: PluginContext): void | Promise<void>
}

/**
 * Lifecycle hooks a plugin can implement (design §6.9). All optional. The reducer
 * semantics (how multiple plugins compose, and what each may change) live in the
 * `@shofer/core` `PluginRegistry`:
 *
 * - `beforeToolCall` — **allow / modify params / block**. Plugins run in
 *   registration order; a returned `modifiedArgs` threads into later hooks and the
 *   tool; the first plugin returning `allow: false` short-circuits the tool with an
 *   optional `reason` (surfaced like a denied tool).
 * - `afterToolCall` — **observe / transform the result**. Each plugin sees the prior
 *   plugin's (possibly transformed) result string; returning a string replaces it.
 * - `beforeAsk` — **observe / modify / auto-answer** an ask. A returned `text`
 *   modifies the surfaced ask; a `decision` of `"approve"`/`"deny"` auto-answers it
 *   (short-circuiting the user prompt), `"ask"`/absent lets it proceed.
 * - `beforeTaskStart` / `afterTaskComplete` — **observers** (owner decision for
 *   Phase 3: kept off the latency-critical path, fired non-blocking). Their return
 *   value is ignored in Phase 3.
 */
export interface LifecycleHooks {
	/**
	 * Observe a task starting (design §6.9). Phase 3 treats this as a fire-and-forget
	 * observer (non-blocking, timeout-guarded); any returned value is ignored.
	 */
	beforeTaskStart?(context: TaskLifecycleContext): void | Promise<void>

	/**
	 * Observe a task completing or aborting (design §6.9). Fire-and-forget observer;
	 * {@link TaskLifecycleContext.reason} distinguishes a normal completion from an abort.
	 */
	afterTaskComplete?(context: TaskLifecycleContext): void | Promise<void>

	/**
	 * Called before a tool executes. May allow it (return `{ allow: true }`), modify
	 * its arguments (`{ allow: true, modifiedArgs }`), or block it
	 * (`{ allow: false, reason }`). Blocking short-circuits the tool.
	 */
	beforeToolCall?(
		toolName: string,
		args: Record<string, unknown>,
		context: PluginContext,
	): BeforeToolCallResult | Promise<BeforeToolCallResult>

	/**
	 * Called after a tool executes with its stringified result. Returning a string
	 * replaces the result the model sees; returning nothing observes without change.
	 */
	afterToolCall?(
		toolName: string,
		args: Record<string, unknown>,
		result: string,
		context: PluginContext,
	): string | void | Promise<string | void>

	/**
	 * Called before an ask is surfaced to the user. May modify the ask (`text`) and/or
	 * auto-answer it (`decision`). Returning nothing (or `{ decision: "ask" }`) lets the
	 * ask proceed to the user unchanged.
	 */
	beforeAsk?(
		askType: string,
		payload: unknown,
		context: PluginContext,
	): BeforeAskResult | void | Promise<BeforeAskResult | void>
}

/**
 * Context handed to the task-level lifecycle observers ({@link LifecycleHooks.beforeTaskStart},
 * {@link LifecycleHooks.afterTaskComplete}). Extends {@link PluginContext} with the
 * task's initial prompt and, for completion, the terminal reason.
 */
export interface TaskLifecycleContext extends PluginContext {
	/** The task's initial prompt (present for `beforeTaskStart`). */
	readonly prompt?: string
	/** Why the task ended, for `afterTaskComplete` (`"completed"` vs `"aborted"`). */
	readonly reason?: "completed" | "aborted"
}

/** Result of a {@link LifecycleHooks.beforeToolCall} hook (design §6.9). */
export interface BeforeToolCallResult {
	/** Whether the tool may run. `false` blocks it (short-circuit with {@link reason}). */
	allow: boolean
	/** Replacement args threaded into the tool and later hooks (honored only when allowed). */
	modifiedArgs?: Record<string, unknown>
	/** Human-readable reason surfaced to the model/user when the call is blocked. */
	reason?: string
}

/** Result of a {@link LifecycleHooks.beforeAsk} hook (design §6.9). */
export interface BeforeAskResult {
	/**
	 * Short-circuit the user prompt: `"approve"`/`"deny"` auto-answers the ask;
	 * `"ask"` (or absent) lets it proceed to the user.
	 */
	decision?: "approve" | "deny" | "ask"
	/** Modified ask text surfaced to the user, or the answer text when auto-answering. */
	text?: string
}

/**
 * The **restricted** host surface handed to a plugin via {@link PluginContext.host}
 * (design §6.2, §8). This is *not* the full `getHost()` `HostBridge`: it exposes
 * only the capabilities the plugin's manifest `permissions` grant, and every call
 * is checked against those permissions at runtime by the plugin sandbox (step 2.4).
 *
 * - {@link fs} — filesystem access, scoped to `permissions.filesystem` paths.
 * - {@link fetch} — network access, scoped to `permissions.network` origins.
 * - {@link notifier} — always available (surfacing messages is inherently safe).
 * - {@link env} — read-only host/environment metadata (safe, no side effects).
 *
 * The type shape is the same regardless of which permissions were granted; an
 * out-of-scope call is denied at runtime (deny + shown/logged warning), not hidden
 * from the type — so a plugin author gets a clear runtime error, not a missing API.
 */
export interface PluginHost {
	/** Filesystem access, scoped to the plugin's `permissions.filesystem` allowlist. */
	readonly fs: HostFileSystem
	/** Surface an info/warning/error message (always permitted). */
	readonly notifier: Pick<Notifier, "info" | "warn" | "error">
	/** Read-only host/environment metadata. */
	readonly env: HostEnv
	/** HTTP access, scoped to the plugin's `permissions.network` origin allowlist. */
	fetch(input: string | URL, init?: RequestInit): Promise<Response>
	/**
	 * Watch files matching `pattern` (a glob) for create/change/delete, invoking
	 * `onChange` on any event (design §6.11 G3; Phase 6). **Scoped to the plugin's
	 * `permissions.filesystem` grant**: it watches `pattern` under each granted root
	 * only. A plugin without a filesystem grant gets a deny + warn (no watcher; the
	 * returned {@link HostDisposable} is a no-op). Dispose to stop watching (the manager
	 * also disposes it on plugin disable). Present only when the host wired a watcher.
	 */
	watch?(pattern: string, onChange: () => void): HostDisposable
}

/**
 * Host LLM/embeddings access handed to a plugin granted `permissions.ai` **and** the
 * billed-calls consent (design §6.11 G1, §8; Phase 6). The plugin never sees raw API
 * keys — only an opaque {@link Handler} (the host's `ApiHandler`, constructed in
 * `@shofer/core` via `buildApiHandler`). `@shofer/types` stays browser-safe by leaving
 * the handler type abstract (defaulting to `unknown`); core wires the concrete
 * `ApiHandler` in (a `PluginAi<ApiHandler>` is assignable to `PluginAi`).
 *
 * Both calls are async because host provider-profile resolution
 * (`ProviderSettingsManager.getProfile`) is async — `→ ApiHandler` in the design is
 * shorthand for "the same handler abstraction `buildApiHandler` returns".
 */
export interface PluginAi<Handler = unknown> {
	/**
	 * Build an {@link Handler} for `profileRef` (a host provider-profile name/id), or the
	 * host's default profile when omitted. Reuses the host's `buildApiHandler` seam, so
	 * the plugin gets the identical `ApiHandler` the main agent uses — never keys.
	 */
	buildHandler(profileRef?: string): Promise<Handler>
	/** Embed `texts` via a host embedder, returning one vector per input text. */
	embed(texts: string[], profileRef?: string): Promise<number[][]>
}

/**
 * A plugin's **private** persistent storage (design §6.11 G2; Phase 6). Rooted at
 * {@link dir} (`<globalStorage>/plugins/<name>/`); every path is resolved relative to
 * it and **traversal-blocked** (a `..` escape is denied). Created lazily, survives
 * restart, removed on uninstall. Works regardless of `permissions.filesystem` — it is
 * the plugin's own sandbox, not host paths.
 */
export interface PluginStorage {
	/** Absolute path of this plugin's storage directory. */
	readonly dir: string
	/** Read a UTF-8 file under {@link dir}. Rejects on traversal or a missing file. */
	readFile(relativePath: string): Promise<string>
	/** Write a UTF-8 file under {@link dir} (parent dirs created). Rejects on traversal. */
	writeFile(relativePath: string, content: string): Promise<void>
	/** Whether a path under {@link dir} exists. Rejects on traversal. */
	exists(relativePath: string): Promise<boolean>
	/** Delete a file under {@link dir}. Rejects on traversal. */
	delete(relativePath: string): Promise<void>
	/** List entries (absolute paths) under {@link dir} or a subdirectory of it. */
	list(relativeDir?: string): Promise<string[]>
}

/**
 * A supervised, long-lived background service a plugin registers via
 * {@link PluginContext.registerService} (design §6.11 G7; Phase 6). {@link start} runs
 * when the plugin is enabled+active; {@link stop} on disable/uninstall/deactivate. The
 * {@link PluginManager} isolates a throwing/hanging `start`/`stop` (timeout + warning)
 * so a bad service can never crash the host.
 */
export interface PluginService {
	/** Service name — used in supervision warnings for attribution. */
	readonly name: string
	/** Start the service. Awaited (with a timeout) when the plugin activates. */
	start(): void | Promise<void>
	/** Stop/dispose the service. Awaited (with a timeout) when the plugin deactivates. */
	stop?(): void | Promise<void>
}

/**
 * Context handed to plugin hooks. Host-agnostic (no `vscode` types). The first two
 * fields are always populated by the hook call sites; {@link taskId}, {@link cwd},
 * {@link config}, and {@link host} are threaded in by the {@link PluginManager} when
 * a code plugin is registered (Phase 2) — they are absent for the seed/no-host case,
 * keeping behavior identical when no plugins are active. {@link ai}, {@link storage},
 * and {@link registerService} are the Phase-6 host capabilities (design §6.11), each
 * present only when the host wired its seam (and, for {@link ai}, only when
 * `permissions.ai` was granted).
 */
export interface PluginContext {
	/** Absolute path of the active workspace, if any. */
	readonly workspacePath?: string
	/** Current mode slug. */
	readonly mode?: string
	/** Id of the task the hook is running for, if applicable (design §6.2). */
	readonly taskId?: string
	/** Current working directory (design §6.2). */
	readonly cwd?: string
	/** This plugin's validated, user-configured settings (design §6.2, step 2.3). */
	readonly config?: Record<string, unknown>
	/** Restricted, permission-checked host surface (design §6.2, §8; step 2.4). */
	readonly host?: PluginHost
	/**
	 * Host LLM/embeddings access (design §6.11 G1; Phase 6). Present **only** when the
	 * plugin was granted `permissions.ai` and the host wired its AI seam. When granted
	 * but the user has not consented to billed calls (§8), this is a denying stub whose
	 * calls throw + warn; when ungranted it is absent entirely.
	 */
	readonly ai?: PluginAi
	/** This plugin's private persistent storage (design §6.11 G2; Phase 6). */
	readonly storage?: PluginStorage
	/**
	 * Register a supervised background service tied to this plugin's lifecycle (design
	 * §6.11 G7; Phase 6). Returns a {@link HostDisposable} that stops + removes the
	 * service. Present only when the host wired the service supervisor.
	 */
	registerService?(service: PluginService): HostDisposable
}

/** A lightweight event surfaced to `onEvent` (decoupled from the telemetry catalog). */
export interface PluginEvent {
	readonly name: string
	readonly properties?: Record<string, unknown>
	/** Task that emitted the event, if any (design §6.10). */
	readonly taskId?: string
	/** When the event occurred (epoch ms), if known (design §6.10). */
	readonly timestamp?: number
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
		/**
		 * Host LLM/embeddings access (`ctx.ai`, Phase 6 / P6.G1). Unlike the other
		 * flags this costs the **user money** (billed model calls), so the grant is
		 * necessary but not sufficient: `ctx.ai` is live only after a **separate**
		 * billed-calls consent (design §8). Granted-but-unconsented ⇒ a denying stub;
		 * ungranted ⇒ `ctx.ai` is absent entirely. The plugin never receives raw keys.
		 */
		ai: z.boolean().optional(),
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
		/**
		 * A **private** (internal) skill: registered and invocable by its qualified
		 * name (`<pluginName>:<name>`) but excluded from every user-facing enumeration
		 * (the skills UI list, the slash-command menu). Absent/false ⇒ user-visible.
		 */
		private: z.boolean().optional(),
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
		/**
		 * A **private** (internal) command: registered and invocable by its qualified
		 * name (`<pluginName>:<command>`) but excluded from every user-facing
		 * enumeration (the command palette / slash-command list). Absent/false ⇒
		 * user-visible.
		 */
		private: z.boolean().optional(),
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

/**
 * A UI bundle a plugin ships for a webview region (design §6.8, P4 external-UI).
 * `region` must also be granted in `permissions.ui` (the grant); this entry points
 * at the plugin's **built** UI module (an ESM file relative to the plugin root, e.g.
 * `ui/toolbar.js`) that the extension serves as a local `vscode-webview://` resource
 * and the webview dynamic-imports. A granted region *without* a matching entry falls
 * back to the webview's co-bundled/first-party component registry (non-breaking).
 *
 * The built module must default-export a React component that takes a single
 * `{ api: PluginUIApi }` prop and **externalize** `react`, `react-dom`, and
 * `react/jsx-runtime` so its `import React` resolves to the host's shared instance
 * (see PLUGINS.md §6 — the host injects an import map for those specifiers).
 */
export const pluginUiEntrySchema = z
	.object({
		region: pluginUiRegionSchema,
		/** Built UI ESM module, relative to the plugin root (e.g. `ui/toolbar.js`). */
		entry: z.string().min(1),
	})
	.strict()

export type PluginUiEntry = z.infer<typeof pluginUiEntrySchema>

/** The declarative `contributes` block (design §5, §6). All entries optional. */
export const pluginContributesSchema = z
	.object({
		modes: z.array(pluginModeContributionSchema).optional(),
		skills: z.array(pluginSkillContributionSchema).optional(),
		commands: z.array(pluginCommandContributionSchema).optional(),
		mcpServers: pluginMcpServersSchema.optional(),
		rules: z.array(pluginRuleContributionSchema).optional(),
		/**
		 * External UI bundles per region (design §6.8, P4). Each entry's `region` must
		 * also be granted in `permissions.ui`; the `entry` names the built ESM module the
		 * extension serves + the webview dynamic-imports. Omit to use a co-bundled component.
		 */
		ui: z.array(pluginUiEntrySchema).optional(),
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
// Plugin API versioning (design §14.2 — owner decision: enforce at load).
//
// The `ShoferPlugin` hook surface is semver'd. A plugin declares the API it was
// built against via the manifest `shoferPluginApiVersion`; Shofer refuses to load
// a plugin whose declared version is incompatible with the host's current API
// (major mismatch, or a host older than the minor/patch the plugin requires) with
// a shown+logged warning. Kept in `@shofer/types` (browser-safe) so the manifest
// schema and the (core-side) loader share one policy.
// ---------------------------------------------------------------------------

/** The plugin API surface version this Shofer build implements (design §14.2). */
export const PLUGIN_API_VERSION = "1.0.0"

/** Parse a bare `major.minor.patch` string; returns `null` when malformed. */
function parsePluginSemver(version: string): { major: number; minor: number; patch: number } | null {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
	if (!match) return null
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * Whether a plugin declaring `declared` as its target plugin-API version can run
 * against a host implementing `host` (defaults to {@link PLUGIN_API_VERSION}).
 * Compatible iff the majors match **and** the host is at least as new as the
 * declared version within that major (a plugin that needs newer features than the
 * host provides, or a different major, is refused). Malformed versions are
 * incompatible (fail-closed).
 */
export function isPluginApiCompatible(declared: string, host: string = PLUGIN_API_VERSION): boolean {
	const d = parsePluginSemver(declared)
	const h = parsePluginSemver(host)
	if (!d || !h) return false
	if (d.major !== h.major) return false
	if (h.minor < d.minor) return false
	if (h.minor === d.minor && h.patch < d.patch) return false
	return true
}

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
	/**
	 * Whether the plugin declares `permissions.ai` — i.e. it wants host LLM/embeddings
	 * access, which makes **billed** calls (design §6.11 G1, §8; Phase 6). Drives the
	 * "uses AI (billed)" badge + consent affordance in the Plugins panel.
	 */
	usesAi?: boolean
	/**
	 * Whether the user has consented to this plugin's billed AI calls (§8). Only
	 * meaningful when {@link usesAi} is true; `ctx.ai` is live only when both hold.
	 */
	aiConsented?: boolean
}

/** Snapshot of discovered plugins pushed to the webview (`ExtensionMessage.plugins`). */
export interface PluginsState {
	plugins: PluginView[]
}

/** Webview → extension request (carried in `WebviewMessage.plugin`). */
export type PluginRequest =
	| { action: "list" }
	| { action: "setEnabled"; name: string; enabled: boolean }
	/**
	 * Grant or revoke consent for a plugin's **billed** AI calls (`permissions.ai`,
	 * design §6.11 G1, §8; Phase 6). Separate from the enable toggle: `ctx.ai` is live
	 * only when the plugin is enabled, declares `permissions.ai`, **and** is consented.
	 */
	| { action: "setAiConsent"; name: string; consented: boolean }
	/** Uninstall a plugin: delete its directory and drop it from the enabled allow-list. */
	| { action: "uninstall"; name: string }
	/**
	 * Install a plugin from a local `.shofer-plugin` archive. The extension opens a file
	 * picker (the webview cannot read local files), unpacks it into the global plugins
	 * dir, and re-discovers. Remote/registry install stays deferred (design §9, §14 Q5).
	 */
	| { action: "installFromFile" }

// ---------------------------------------------------------------------------
// Plugin UI contributions (design §6.8, §12; Phase 4)
//
// A plugin may contribute React components into named webview regions
// ({@link PluginUiRegion}). Per the owner decision (§14 Q1) the component is loaded
// into the webview via dynamic import with a restricted API — NOT a sandboxed
// iframe — so it shares the host's React/theme. It receives only a {@link PluginUIApi}:
// a *scoped* message channel to its extension-side plugin plus a read-only context
// blob. No direct `vscode` API and no DOM escape are exposed.
//
// These types are the shared contract between the webview (`PluginSlot`) and the
// extension (`ui-registry` + provider routing). They are React-free so
// `@shofer/types` stays browser-safe — the concrete `React.ComponentType` lives in
// the webview, keyed by {@link PluginUiContribution.componentId}.
// ---------------------------------------------------------------------------

/** Read-only snapshot of the current task handed to a plugin UI component (design §6.8). */
export interface PluginUiTaskSummary {
	/** Id of the active task, if any. */
	readonly taskId?: string
	/** Current mode slug, if any. */
	readonly mode?: string
}

/**
 * The read-only context blob a plugin UI component receives (design §6.8). Carries
 * the region it is mounted in, the contributing plugin's name, the current task
 * summary, the plugin's user config, and theme variables — everything the component
 * may *read*. The only way to affect host state is {@link PluginUIApi.postMessage}.
 */
export interface PluginUIContext {
	/** The region this component is mounted in. */
	readonly region: PluginUiRegion
	/** The contributing plugin's name (also the channel namespace). */
	readonly pluginName: string
	/** Read-only summary of the active task. */
	readonly task?: PluginUiTaskSummary
	/** This plugin's validated, user-configured settings (design §6.2). */
	readonly config?: Record<string, unknown>
	/** VS Code theme CSS variables (name → value), for theme-aware rendering. */
	readonly theme?: Record<string, string>
}

/**
 * The **restricted** surface handed to a plugin UI component (design §6.8, §14 Q1).
 * Scoped to a single plugin: {@link postMessage} tags every outgoing message with the
 * plugin's name so the extension routes it only to that plugin's extension-side code,
 * and {@link onMessage} only ever receives messages addressed to this plugin
 * (namespacing — one plugin can neither spoof nor observe another). {@link context}
 * is the read-only blob. No `vscode` API and no parent-DOM access are exposed.
 */
export interface PluginUIApi {
	/** Send a message to this plugin's extension-side code (scoped to the plugin). */
	postMessage(message: unknown): void
	/** Subscribe to messages addressed to this plugin. Returns an unsubscribe fn. */
	onMessage(listener: (message: unknown) => void): () => void
	/** Read-only context (region, task, config, theme). */
	readonly context: PluginUIContext
}

/**
 * A single plugin UI contribution: plugin {@link pluginName} renders {@link componentId}
 * into {@link region}. Produced by the permission-gated UI registry from enabled
 * manifests and pushed to the webview, which resolves {@link componentId} to a React
 * component. {@link componentId} is namespaced (`<pluginName>:<region>`) so it is
 * globally unique across plugins and regions.
 */
export interface PluginUiContribution {
	readonly pluginName: string
	readonly region: PluginUiRegion
	readonly componentId: string
	/**
	 * Optional URL to the plugin's UI bundle, resolved to a local `vscode-webview://`
	 * resource (design §14 Q1 — CSP `strict-dynamic` permits importing scripts from
	 * `cspSource`, not arbitrary hosts). Absent for co-bundled/fixture components, which
	 * the webview resolves from its built-in component registry.
	 */
	readonly source?: string
}

/** Snapshot of plugin UI contributions pushed to the webview (`ExtensionMessage.pluginUiContributions`). */
export interface PluginUiContributionsState {
	contributions: PluginUiContribution[]
}

/**
 * A message on the scoped plugin-UI ↔ plugin-extension channel (design §6.8). The
 * {@link pluginName} namespaces the message so routing (both directions) is confined
 * to one plugin. Carried by `WebviewMessage.pluginUiMessage` (UI → extension) and
 * `ExtensionMessage.pluginUiMessage` (extension → UI).
 */
export interface PluginUiMessageEnvelope {
	pluginName: string
	message: unknown
}
