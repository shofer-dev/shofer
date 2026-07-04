import type {
	BeforeAskResult,
	BeforeToolCallResult,
	CustomToolDefinition,
	LifecycleHooks,
	PluginContext,
	PluginEvent,
	ShoferPlugin,
	TaskLifecycleContext,
} from "@shofer/types"

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
/** Per-plugin grants the registry needs to know at hook time (design §8). */
export interface PluginGrants {
	/**
	 * Whether the plugin's manifest granted `permissions.lifecycle`. Only plugins with
	 * this grant participate in {@link PluginRegistry.applyLifecycleHook} — an ungranted
	 * plugin's `lifecycle` hooks never fire (design §6.9, §8).
	 */
	lifecycle?: boolean
}

export class PluginRegistry {
	private readonly plugins: ShoferPlugin[] = []
	/** Names of plugins granted `permissions.lifecycle` (see {@link PluginGrants}). */
	private readonly lifecycleGranted = new Set<string>()

	/**
	 * Register a plugin and run its `initialize` hook. Names must be unique. `grants`
	 * carries the manifest permissions the registry gates on (currently just
	 * `lifecycle`); omitted ⇒ no lifecycle participation (fail-closed).
	 */
	async register(plugin: ShoferPlugin, context: PluginContext = {}, grants: PluginGrants = {}): Promise<void> {
		if (this.plugins.some((p) => p.name === plugin.name)) {
			throw new Error(`Plugin '${plugin.name}' is already registered`)
		}
		this.plugins.push(plugin)
		if (grants.lifecycle) this.lifecycleGranted.add(plugin.name)
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
		this.lifecycleGranted.delete(name)
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

	// --- Lifecycle hooks (design §6.9, Phase 3) --------------------------------

	/**
	 * Plugins that (a) were granted `permissions.lifecycle` **and** (b) declare
	 * `hookName`, in registration order. This is the participation set every lifecycle
	 * reducer iterates — an ungranted plugin is filtered out here, so its hook can
	 * never fire (design §6.9, §8).
	 */
	private lifecyclePlugins<K extends keyof LifecycleHooks>(hookName: K): ShoferPlugin[] {
		return this.plugins.filter((p) => p.lifecycle?.[hookName] && this.lifecycleGranted.has(p.name))
	}

	/**
	 * Whether any permitted plugin declares `hookName`. Hot call sites
	 * (`presentAssistantMessage`, `Task.ask`) use this as a fast-path guard so that
	 * with zero lifecycle plugins they skip the hook machinery entirely and behave
	 * byte-for-byte as before.
	 */
	hasLifecycleHook<K extends keyof LifecycleHooks>(hookName: K): boolean {
		return this.plugins.some((p) => p.lifecycle?.[hookName] && this.lifecycleGranted.has(p.name))
	}

	/**
	 * Generic lifecycle-hook runner (design §6.9, owner decision #8). Iterates the
	 * permitted plugins declaring `hookName` in registration order, invoking
	 * `run(hook, plugin)` for each — wrapped in the shared {@link PLUGIN_HOOK_TIMEOUT_MS}
	 * timeout and per-plugin error isolation. A hook that throws or exceeds the budget
	 * is skipped (its `run` never applies its mutation, since each reducer mutates its
	 * accumulator only *after* awaiting the hook) with a shown+logged warning, so one
	 * slow/bad plugin can never stall or crash the task. `run` may return `{ stop: true }`
	 * to short-circuit the remaining plugins (used by `beforeToolCall`/`beforeAsk`).
	 */
	async applyLifecycleHook<K extends keyof LifecycleHooks>(
		hookName: K,
		run: (hook: NonNullable<LifecycleHooks[K]>, plugin: ShoferPlugin) => Promise<{ stop?: boolean } | void>,
	): Promise<void> {
		for (const plugin of this.lifecyclePlugins(hookName)) {
			const hook = plugin.lifecycle![hookName] as NonNullable<LifecycleHooks[K]>
			try {
				const outcome = await withHookTimeout<{ stop?: boolean } | void>(
					Promise.resolve(run(hook, plugin)),
					() => {
						warnPlugin(
							`[plugin:${plugin.name}] ${String(hookName)} exceeded ${PLUGIN_HOOK_TIMEOUT_MS}ms — skipped.`,
						)
						return undefined
					},
				)
				if (outcome?.stop) break
			} catch (error) {
				warnPlugin(`[plugin:${plugin.name}] ${String(hookName)} failed: ${String(error)} — skipped.`)
			}
		}
	}

	/**
	 * Run `beforeToolCall` across permitted plugins (design §6.9). Reducer semantics:
	 * plugins run in registration order threading `args`; a plugin's `modifiedArgs`
	 * becomes the args passed to later plugins and, ultimately, the tool; the **first**
	 * plugin returning `allow: false` blocks the tool (short-circuit) and its `reason`
	 * is returned. When nothing blocks, `allow: true` is returned with `modifiedArgs`
	 * set only if some plugin actually changed the args.
	 */
	async applyBeforeToolCall(
		toolName: string,
		args: Record<string, unknown>,
		context: PluginContext = {},
	): Promise<BeforeToolCallResult> {
		let current = args
		let blockedReason: string | undefined
		let blocked = false
		await this.applyLifecycleHook("beforeToolCall", async (hook) => {
			const res = await hook(toolName, current, context)
			if (!res) return
			if (res.allow === false) {
				blocked = true
				blockedReason = res.reason
				return { stop: true }
			}
			if (res.modifiedArgs) current = res.modifiedArgs
			return undefined
		})
		if (blocked) return { allow: false, reason: blockedReason }
		return { allow: true, modifiedArgs: current === args ? undefined : current }
	}

	/**
	 * Run `afterToolCall` across permitted plugins (design §6.9). Each plugin observes
	 * (and may transform) the running result string in registration order — a returned
	 * string replaces it for later plugins and the model. Returns the final result.
	 */
	async applyAfterToolCall(
		toolName: string,
		args: Record<string, unknown>,
		result: string,
		context: PluginContext = {},
	): Promise<string> {
		let current = result
		await this.applyLifecycleHook("afterToolCall", async (hook) => {
			const out = await hook(toolName, args, current, context)
			if (typeof out === "string") current = out
		})
		return current
	}

	/**
	 * Run `beforeAsk` across permitted plugins (design §6.9). A plugin may modify the
	 * ask text (threaded to later plugins and the surfaced ask) and/or auto-answer it;
	 * the **first** plugin returning a non-`"ask"` `decision` short-circuits the user
	 * prompt. Returns `undefined` when no plugin participated (so the caller's ask path
	 * is byte-for-byte unchanged), otherwise the merged `{ decision, text }`.
	 */
	async applyBeforeAsk(askType: string, payload: unknown, context: PluginContext = {}): Promise<BeforeAskResult | undefined> {
		let participated = false
		let text: string | undefined
		let decision: BeforeAskResult["decision"]
		await this.applyLifecycleHook("beforeAsk", async (hook) => {
			const res = await hook(askType, payload, context)
			if (!res) return
			participated = true
			if (typeof res.text === "string") text = res.text
			if (res.decision && res.decision !== "ask") {
				decision = res.decision
				return { stop: true }
			}
			return undefined
		})
		if (!participated) return undefined
		return { decision: decision ?? "ask", text }
	}

	/**
	 * Notify permitted plugins that a task is starting (design §6.9). Observer-only in
	 * Phase 3: timeout-guarded and error-isolated. Callers invoke this **without
	 * awaiting** (owner decision: off the latency-critical path), so a plugin's work
	 * never delays task start.
	 */
	async notifyBeforeTaskStart(context: TaskLifecycleContext): Promise<void> {
		await this.applyLifecycleHook("beforeTaskStart", async (hook) => {
			await hook(context)
		})
	}

	/**
	 * Notify permitted plugins that a task completed or aborted (design §6.9).
	 * Observer-only, timeout-guarded, invoked non-blocking like {@link notifyBeforeTaskStart}.
	 */
	async notifyAfterTaskComplete(context: TaskLifecycleContext): Promise<void> {
		await this.applyLifecycleHook("afterTaskComplete", async (hook) => {
			await hook(context)
		})
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
