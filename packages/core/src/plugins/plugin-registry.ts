import type {
	ApiRequestFinishedPayload,
	ApiRequestStartInfo,
	AskResolvedInfo,
	BeforeAskResult,
	BeforeToolCallResult,
	CustomToolDefinition,
	AssistantMessageInfo,
	LifecycleHooks,
	PluginContext,
	PluginEvent,
	PluginFileEdit,
	PluginFileEditResult,
	ShoferPlugin,
	TaskDeletedInfo,
	TaskLifecycleContext,
	TimelineRewindInfo,
	UserMessageInfo,
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
async function withHookTimeout<T>(
	promise: Promise<T>,
	onTimeout: () => T,
	timeoutMs = PLUGIN_HOOK_TIMEOUT_MS,
): Promise<T> {
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
 * a future server. Distribution/curation layers sit above this substrate rather
 * than being the extension mechanism itself.
 */
/** Per-plugin grants the registry needs to know at hook time (design §8). */
export interface PluginGrants {
	/**
	 * Whether the plugin's manifest granted `permissions.lifecycle`. Only plugins with
	 * this grant participate in {@link PluginRegistry.applyLifecycleHook} — an ungranted
	 * plugin's `lifecycle` hooks never fire (design §6.9, §8).
	 */
	lifecycle?: boolean
	/**
	 * The plugin's manifest `hookTimeoutMs`, when it declared one. Overrides
	 * {@link PLUGIN_HOOK_TIMEOUT_MS} for *that plugin's* hooks only, so a plugin doing
	 * work the agent must genuinely wait for (snapshotting a workspace before a
	 * file-mutating tool) is not silently skipped, while every other plugin keeps the
	 * strict default. Already range-validated by the manifest schema.
	 */
	hookTimeoutMs?: number
}

export class PluginRegistry {
	private readonly plugins: ShoferPlugin[] = []
	/** Names of plugins granted `permissions.lifecycle` (see {@link PluginGrants}). */
	private readonly lifecycleGranted = new Set<string>()
	/** Per-plugin hook budgets (see {@link PluginGrants.hookTimeoutMs}). */
	private readonly hookBudgets = new Map<string, number>()
	/**
	 * The rich {@link PluginContext} each plugin was registered with — its `host`,
	 * `storage`, `ai`, `task`, `config`, … capabilities. Hook call sites in the task
	 * loop can only supply the *situational* half (`taskId`, `cwd`, `mode`, `turn`),
	 * because that is all they know; merging the registered half back in here is what
	 * lets a hook use `ctx.task`/`ctx.storage` directly instead of every plugin having
	 * to stash its context in a module-level global at `initialize` time.
	 */
	private readonly contexts = new Map<string, PluginContext>()
	/**
	 * Monotonic counter bumped on every register/unregister. Consumers that **cache**
	 * plugin-derived state (e.g. the per-task tool catalog in {@link Task}) fold this into
	 * their cache key so the cache invalidates when the plugin set changes — critical
	 * because code plugins load **asynchronously** (fire-and-forget), so a task's first
	 * tool build can happen before a plugin's `registerTools` has contributed.
	 */
	private _revision = 0
	/** See {@link _revision}. */
	get revision(): number {
		return this._revision
	}

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
		if (grants.hookTimeoutMs) this.hookBudgets.set(plugin.name, grants.hookTimeoutMs)
		this.contexts.set(plugin.name, context)
		this._revision++
		await plugin.initialize?.(context)
	}

	/** This plugin's hook budget — its manifest override, else the shared default. */
	private budgetFor(pluginName: string): number {
		return this.hookBudgets.get(pluginName) ?? PLUGIN_HOOK_TIMEOUT_MS
	}

	/**
	 * The context a hook receives: the plugin's registered capabilities overlaid with
	 * the call site's situational fields (which win, since they describe *this* call).
	 * Undefined situational values never clobber a registered one.
	 */
	private contextFor(pluginName: string, callContext: PluginContext): PluginContext {
		const registered = this.contexts.get(pluginName)
		if (!registered) return callContext
		const situational = Object.fromEntries(
			Object.entries(callContext).filter(([, value]) => value !== undefined),
		) as PluginContext
		return { ...registered, ...situational }
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
		this.hookBudgets.delete(name)
		this.contexts.delete(name)
		this._revision++
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
				const budget = this.budgetFor(plugin.name)
				const contributed = await withHookTimeout(
					Promise.resolve(plugin.registerTools(this.contextFor(plugin.name, context))),
					() => {
						warnPlugin(`[plugin:${plugin.name}] registerTools exceeded ${budget}ms — skipped.`)
						return [] as CustomToolDefinition[]
					},
					budget,
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
				const budget = this.budgetFor(plugin.name)
				result = await withHookTimeout(
					Promise.resolve(plugin.transformSystemPrompt(result, this.contextFor(plugin.name, context))),
					() => {
						warnPlugin(`[plugin:${plugin.name}] transformSystemPrompt exceeded ${budget}ms — skipped.`)
						return result
					},
					budget,
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
	 * `run(hook, plugin, context)` for each — wrapped in that plugin's hook budget
	 * ({@link PLUGIN_HOOK_TIMEOUT_MS} unless its manifest raised it) and per-plugin error
	 * isolation. A hook that throws or exceeds the budget is skipped (its `run` never
	 * applies its mutation, since each reducer mutates its accumulator only *after*
	 * awaiting the hook) with a shown+logged warning, so one slow/bad plugin can never
	 * stall or crash the task. `run` may return `{ stop: true }` to short-circuit the
	 * remaining plugins (used by `beforeToolCall`/`beforeAsk`).
	 *
	 * `context` is the **call site's** situational context; each plugin's `run` receives
	 * it merged over that plugin's registered capabilities (see {@link contextFor}).
	 */
	async applyLifecycleHook<K extends keyof LifecycleHooks>(
		hookName: K,
		run: (
			hook: NonNullable<LifecycleHooks[K]>,
			plugin: ShoferPlugin,
			context: PluginContext,
		) => Promise<{ stop?: boolean } | void>,
		context: PluginContext = {},
	): Promise<void> {
		for (const plugin of this.lifecyclePlugins(hookName)) {
			const hook = plugin.lifecycle![hookName] as NonNullable<LifecycleHooks[K]>
			const budget = this.budgetFor(plugin.name)
			try {
				const outcome = await withHookTimeout<{ stop?: boolean } | void>(
					Promise.resolve(run(hook, plugin, this.contextFor(plugin.name, context))),
					() => {
						warnPlugin(`[plugin:${plugin.name}] ${String(hookName)} exceeded ${budget}ms — skipped.`)
						return undefined
					},
					budget,
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
		await this.applyLifecycleHook(
			"beforeToolCall",
			async (hook, _plugin, ctx) => {
				const res = await hook(toolName, current, ctx)
				if (!res) return
				if (res.allow === false) {
					blocked = true
					blockedReason = res.reason
					return { stop: true }
				}
				if (res.modifiedArgs) current = res.modifiedArgs
				return undefined
			},
			context,
		)
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
		await this.applyLifecycleHook(
			"afterToolCall",
			async (hook, _plugin, ctx) => {
				const out = await hook(toolName, args, current, ctx)
				if (typeof out === "string") current = out
			},
			context,
		)
		return current
	}

	/**
	 * Run `beforeAsk` across permitted plugins (design §6.9). A plugin may modify the
	 * ask text (threaded to later plugins and the surfaced ask) and/or auto-answer it;
	 * the **first** plugin returning a non-`"ask"` `decision` short-circuits the user
	 * prompt. Returns `undefined` when no plugin participated (so the caller's ask path
	 * is byte-for-byte unchanged), otherwise the merged `{ decision, text }`.
	 */
	async applyBeforeAsk(
		askType: string,
		payload: unknown,
		context: PluginContext = {},
	): Promise<BeforeAskResult | undefined> {
		let participated = false
		let text: string | undefined
		let decision: BeforeAskResult["decision"]
		await this.applyLifecycleHook(
			"beforeAsk",
			async (hook, _plugin, ctx) => {
				const res = await hook(askType, payload, ctx)
				if (!res) return
				participated = true
				if (typeof res.text === "string") text = res.text
				if (res.decision && res.decision !== "ask") {
					decision = res.decision
					return { stop: true }
				}
				return undefined
			},
			context,
		)
		if (!participated) return undefined
		return { decision: decision ?? "ask", text }
	}

	/**
	 * Tell permitted plugins how an ask ended (design §6.9) — the observer half
	 * `beforeAsk` cannot be, since that hook runs before the host's own
	 * auto-approval decision and therefore never sees the verdict.
	 *
	 * Observer-only; callers invoke it **without awaiting**, so a plugin can never
	 * delay an answer reaching the code that was blocked on it.
	 */
	async notifyAfterAsk(info: AskResolvedInfo, context: PluginContext = {}): Promise<void> {
		await this.applyLifecycleHook(
			"afterAsk",
			async (hook, _plugin, ctx) => {
				await hook(info, ctx)
			},
			{ taskId: info.taskId, askId: info.askId, ...context },
		)
	}

	/**
	 * Tell permitted plugins an LLM request is about to be issued (design §6.9).
	 * Observer-only and **not awaited** — nothing may sit in front of a request.
	 */
	async notifyApiRequestStart(info: ApiRequestStartInfo, context: PluginContext = {}): Promise<void> {
		await this.applyLifecycleHook(
			"onApiRequestStart",
			async (hook, _plugin, ctx) => {
				await hook(info, ctx)
			},
			{ taskId: info.taskId, ...context },
		)
	}

	/**
	 * Hand permitted plugins the host's own per-request record when an LLM request
	 * finishes (design §6.9). Observer-only, not awaited.
	 */
	async notifyApiRequestFinish(info: ApiRequestFinishedPayload, context: PluginContext = {}): Promise<void> {
		await this.applyLifecycleHook(
			"onApiRequestFinish",
			async (hook, _plugin, ctx) => {
				await hook(info, ctx)
			},
			{ taskId: info.taskId, ...context },
		)
	}

	/**
	 * Notify permitted plugins that a task is starting (design §6.9). Observer-only in
	 * Phase 3: timeout-guarded and error-isolated. Callers invoke this **without
	 * awaiting** (owner decision: off the latency-critical path), so a plugin's work
	 * never delays task start.
	 */
	async notifyBeforeTaskStart(context: TaskLifecycleContext): Promise<void> {
		await this.applyLifecycleHook(
			"beforeTaskStart",
			async (hook, _plugin, ctx) => {
				await hook({ ...ctx, prompt: context.prompt, reason: context.reason, trace: context.trace })
			},
			context,
		)
	}

	/**
	 * Notify permitted plugins that a task completed or aborted (design §6.9).
	 * Observer-only, timeout-guarded, invoked non-blocking like {@link notifyBeforeTaskStart}.
	 */
	async notifyAfterTaskComplete(context: TaskLifecycleContext): Promise<void> {
		await this.applyLifecycleHook(
			"afterTaskComplete",
			async (hook, _plugin, ctx) => {
				await hook({ ...ctx, prompt: context.prompt, reason: context.reason })
			},
			context,
		)
	}

	/**
	 * Tell permitted plugins a task's chat timeline is about to be rewound to `info.ts`
	 * (design §6.9). **Awaited** by the caller, unlike the task-lifecycle observers: a
	 * plugin rolling back state anchored to the doomed messages (a workspace snapshot)
	 * must finish *before* they are gone, so its work is ordered, not merely observed.
	 * Each plugin still runs under its own budget with error isolation, so a slow or
	 * failing plugin degrades to "its state wasn't rolled back" rather than blocking the
	 * rewind.
	 */
	async notifyTimelineRewind(info: TimelineRewindInfo, context: PluginContext = {}): Promise<void> {
		await this.applyLifecycleHook(
			"onTimelineRewind",
			async (hook, _plugin, ctx) => {
				await hook(info, ctx)
			},
			{ taskId: info.taskId, ...context },
		)
	}

	/**
	 * Hand permitted plugins the content of a file **before** a tool mutates it
	 * (design §6.9). Awaited: a "before" snapshot taken after the write is worthless,
	 * so the tool waits — under each plugin's hook budget, and errors are isolated, so
	 * a slow or broken plugin cannot block or fail the edit.
	 */
	async applyBeforeFileEdit(edit: PluginFileEdit, context: PluginContext = {}): Promise<void> {
		await this.applyLifecycleHook(
			"beforeFileEdit",
			async (hook, _plugin, ctx) => {
				await hook(edit, ctx)
			},
			context,
		)
	}

	/**
	 * Tell permitted plugins a tool finished mutating a file (design §6.9). The new
	 * content is on disk; observer-only, so callers do not await it.
	 */
	async applyAfterFileEdit(edit: PluginFileEditResult, context: PluginContext = {}): Promise<void> {
		await this.applyLifecycleHook(
			"afterFileEdit",
			async (hook, _plugin, ctx) => {
				await hook(edit, ctx)
			},
			context,
		)
	}

	/**
	 * Tell permitted plugins a task was deleted from history (design §6.9), so a plugin
	 * holding per-task state *outside* the task directory can drop it. Observer-only.
	 */
	async notifyTaskDeleted(info: TaskDeletedInfo, context: PluginContext = {}): Promise<void> {
		await this.applyLifecycleHook(
			"onTaskDeleted",
			async (hook, _plugin, ctx) => {
				await hook(info, ctx)
			},
			{ taskId: info.taskId, workspacePath: info.workspacePath, ...context },
		)
	}

	/**
	 * Tell permitted plugins the user sent a message into a running task (design §6.9).
	 * Observer-only; callers invoke it **without awaiting** so a plugin never delays
	 * the user's message reaching the agent.
	 */
	async notifyUserMessage(info: UserMessageInfo, context: PluginContext = {}): Promise<void> {
		await this.applyLifecycleHook(
			"onUserMessage",
			async (hook, _plugin, ctx) => {
				await hook(info, ctx)
			},
			{ taskId: info.taskId, ...context },
		)
	}

	/**
	 * Tell permitted plugins the agent completed a narration text block (design §6.9)
	 * — the assistant's prose between tool calls, which no other hook carries.
	 * Observer-only; callers invoke it **without awaiting** so a plugin never sits
	 * inside the streaming path.
	 */
	async notifyAssistantMessage(info: AssistantMessageInfo, context: PluginContext = {}): Promise<void> {
		await this.applyLifecycleHook(
			"onAssistantMessage",
			async (hook, _plugin, ctx) => {
				await hook(info, ctx)
			},
			{ taskId: info.taskId, ...context },
		)
	}

	/**
	 * Call a plugin's {@link ShoferPlugin.handleRequest} and return its result (design
	 * §5.12) — the request/response counterpart to the fire-and-forget hooks.
	 *
	 * Deliberately **not** timeout-guarded or error-isolated the way observer hooks are:
	 * a request has a caller waiting on the answer, so a failure must reach that caller
	 * (which can decide) instead of being swallowed into a silent `undefined`. Unknown
	 * plugin, or one declaring no `handleRequest`, throws for the same reason.
	 */
	/**
	 * Ask **every** plugin that implements `handleRequest` the same question, and
	 * collect the answers that came back.
	 *
	 * The broadcast counterpart of {@link request}, for the cases where core needs a
	 * fact that a *feature* owns without knowing which plugin (if any) provides it —
	 * e.g. `"task-stats"`, answered by whatever plugin is tracking this task's file
	 * changes. A plugin that does not recognise the method throws, which is treated as
	 * "no answer" rather than an error: not answering is the normal case.
	 */
	async requestAll(method: string, params: unknown, context: PluginContext = {}): Promise<unknown[]> {
		const answers: unknown[] = []
		for (const plugin of this.plugins) {
			if (!plugin.handleRequest) continue
			try {
				const answer = await plugin.handleRequest(method, params, this.contextFor(plugin.name, context))
				if (answer !== undefined) answers.push(answer)
			} catch {
				/* the plugin does not answer this question */
			}
		}
		return answers
	}

	async request(pluginName: string, method: string, params: unknown, context: PluginContext = {}): Promise<unknown> {
		const plugin = this.plugins.find((p) => p.name === pluginName)
		if (!plugin) {
			throw new Error(`Plugin '${pluginName}' is not registered (enabled?) — cannot handle request '${method}'`)
		}
		if (!plugin.handleRequest) {
			throw new Error(`Plugin '${pluginName}' does not implement handleRequest — cannot handle '${method}'`)
		}
		return plugin.handleRequest(method, params, this.contextFor(pluginName, context))
	}

	/** Dispatch an event to every plugin's `onEvent` (errors are swallowed). */
	dispatchEvent(event: PluginEvent, context: PluginContext = {}): void {
		for (const plugin of this.plugins) {
			try {
				plugin.onEvent?.(event, this.contextFor(plugin.name, context))
			} catch {
				// Observers must never break the caller.
			}
		}
	}

	/**
	 * Deliver a plugin-UI channel message to **only** the named plugin's `onUiMessage`
	 * (design §6.8, Phase 4). Namespaced by construction: the message reaches the
	 * `pluginName` plugin and no other, so one plugin can neither observe nor spoof
	 * another's channel. Errors and timeouts are isolated and warned (like `onEvent`) so
	 * a bad plugin can never break the host. No-op when the plugin is absent or declares
	 * no `onUiMessage`. Fire-and-forget: the caller does not await delivery.
	 */
	async dispatchUiMessage(pluginName: string, message: unknown, context: PluginContext = {}): Promise<void> {
		const plugin = this.plugins.find((p) => p.name === pluginName)
		if (!plugin?.onUiMessage) return
		try {
			const budget = this.budgetFor(pluginName)
			await withHookTimeout(
				Promise.resolve(plugin.onUiMessage(message, this.contextFor(pluginName, context))),
				() => {
					warnPlugin(`[plugin:${pluginName}] onUiMessage exceeded ${budget}ms — skipped.`)
				},
				budget,
			)
		} catch (error) {
			warnPlugin(`[plugin:${pluginName}] onUiMessage failed: ${String(error)} — skipped.`)
		}
	}
}

/** Shared registry instance. */
export const pluginRegistry = new PluginRegistry()
