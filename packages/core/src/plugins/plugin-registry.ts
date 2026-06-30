import type { CustomToolDefinition, PluginContext, PluginEvent, ShoferPlugin } from "@shofer/types"

/**
 * Plugin registry (v3 architecture §10).
 *
 * Collects {@link ShoferPlugin}s and runs their hooks at the right points:
 * tool contribution, system-prompt transformation, and event observation.
 * Host-agnostic — no `vscode` imports — so it runs in the extension, the CLI, or
 * a future server. The marketplace becomes curation/distribution over this
 * substrate rather than the extension mechanism itself.
 */
export class PluginRegistry {
	private readonly plugins: ShoferPlugin[] = []

	/** Register a plugin and run its `initialize` hook. Names must be unique. */
	async register(plugin: ShoferPlugin, context: PluginContext = {}): Promise<void> {
		if (this.plugins.some((p) => p.name === plugin.name)) {
			throw new Error(`Plugin '${plugin.name}' is already registered`)
		}
		this.plugins.push(plugin)
		await plugin.initialize?.(context)
	}

	/** Registered plugin names, in registration order. */
	list(): string[] {
		return this.plugins.map((p) => p.name)
	}

	/** Collect tools contributed by all plugins (in registration order). */
	async collectTools(context: PluginContext = {}): Promise<CustomToolDefinition[]> {
		const tools: CustomToolDefinition[] = []
		for (const plugin of this.plugins) {
			if (plugin.registerTools) {
				tools.push(...(await plugin.registerTools(context)))
			}
		}
		return tools
	}

	/**
	 * Run every plugin's `transformSystemPrompt` in registration order, threading
	 * each result into the next. A throwing plugin is skipped (its transform is a
	 * no-op) so one bad plugin can't break prompt assembly.
	 */
	async applySystemPromptTransforms(prompt: string, context: PluginContext = {}): Promise<string> {
		let result = prompt
		for (const plugin of this.plugins) {
			if (!plugin.transformSystemPrompt) continue
			try {
				result = await plugin.transformSystemPrompt(result, context)
			} catch {
				// Skip a failing transform; keep the prior prompt.
			}
		}
		return result
	}

	/** Dispatch an event to every plugin's `onEvent` (errors are swallowed). */
	dispatchEvent(event: PluginEvent, context: PluginContext = {}): void {
		for (const plugin of this.plugins) {
			try {
				plugin.onEvent?.(event, context)
			} catch {
				// Observers must never break the caller.
			}
		}
	}
}

/** Shared registry instance. */
export const pluginRegistry = new PluginRegistry()
