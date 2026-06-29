import type { CustomToolDefinition } from "./custom-tool.js"

/**
 * Typed plugin API (todos/opencode_inspired_work.md §10).
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
