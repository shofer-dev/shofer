import type { CustomToolDefinition, PluginContext, PluginEvent, ShoferPlugin } from "@shofer/types"

import { warnPlugin } from "./plugin-warnings.js"

/**
 * Per-hook wall-clock budget for the on-the-hot-path hooks (`registerTools`,
 * `transformSystemPrompt`) — owner decision #8. A hook that exceeds it is aborted:
 * its contribution is skipped (tools: none added; prompt: prior value kept) and a
 * shown+logged warning names the offending plugin, so one slow plugin can never
 * stall tool assembly or prompt generation.
 */
export const PLUGIN_HOOK_TIMEOUT_MS = 500

/**
 * Race `promise` against a {@link PLUGIN_HOOK_TIMEOUT_MS} timer. Resolves to the
 * promise's value if it wins, or to `onTimeout()` if the timer fires first. The
 * timer is always cleared so it never keeps the event loop alive.
 */
async function withHookTimeout<T>(promise: Promise<T>, onTimeout: () => T, timeoutMs = PLUGIN_HOOK_TIMEOUT_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<{ __timedOut: true }>((resolve) => {
		timer = setTimeout(() => resolve({ __timedOut: true }), timeoutMs)
	})
	try {
		const result = await Promise.race([promise.then((value) => ({ value }) as const), timeout])
		return "__timedOut" in result ? onTimeout() : result.value
	} finally {
		if (timer) clearTimeout(timer)
	}
}

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

	/** Whether a plugin with `name` is currently registered. */
	has(name: string): boolean {
		return this.plugins.some((p) => p.name === name)
	}

	/**
	 * Remove a plugin from the registry (used when a plugin is disabled/uninstalled).
	 * Its tools/prompt transforms/event observers stop firing on the next hook run.
	 * Returns whether a plugin was removed.
	 */
	unregister(name: string): boolean {
		const index = this.plugins.findIndex((p) => p.name === name)
		if (index === -1) return false
		this.plugins.splice(index, 1)
		return true
	}

	/**
	 * Collect tools contributed by all plugins (in registration order). Each
	 * plugin's `registerTools` is bounded by {@link PLUGIN_HOOK_TIMEOUT_MS}: a hook
	 * that throws or exceeds the budget contributes nothing and is warned about, so
	 * a bad/slow plugin can't break or stall tool assembly.
	 */
	async collectTools(context: PluginContext = {}): Promise<CustomToolDefinition[]> {
		const tools: CustomToolDefinition[] = []
		for (const plugin of this.plugins) {
			if (!plugin.registerTools) continue
			try {
				const contributed = await withHookTimeout(
					Promise.resolve(plugin.registerTools(context)),
					() => {
						warnPlugin(
							`[plugin:${plugin.name}] registerTools exceeded ${PLUGIN_HOOK_TIMEOUT_MS}ms — skipped.`,
						)
						return [] as CustomToolDefinition[]
					},
				)
				tools.push(...contributed)
			} catch (error) {
				warnPlugin(`[plugin:${plugin.name}] registerTools failed: ${String(error)} — skipped.`)
			}
		}
		return tools
	}

	/**
	 * Run every plugin's `transformSystemPrompt` in registration order, threading
	 * each result into the next. A throwing plugin, or one that exceeds
	 * {@link PLUGIN_HOOK_TIMEOUT_MS}, is skipped (its transform is a no-op, the prior
	 * prompt is kept) so one bad/slow plugin can't break or stall prompt assembly.
	 */
	async applySystemPromptTransforms(prompt: string, context: PluginContext = {}): Promise<string> {
		let result = prompt
		for (const plugin of this.plugins) {
			if (!plugin.transformSystemPrompt) continue
			try {
				result = await withHookTimeout(
					Promise.resolve(plugin.transformSystemPrompt(result, context)),
					() => {
						warnPlugin(
							`[plugin:${plugin.name}] transformSystemPrompt exceeded ${PLUGIN_HOOK_TIMEOUT_MS}ms — skipped.`,
						)
						return result
					},
				)
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
