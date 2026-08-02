/**
 * second-brain — the ShoferPlugin: hooks feed, the service thinks, notify+marker speak.
 *
 * The hooks do nothing but project the event and append it to the right task's
 * observer (in-memory, no I/O, back in well under the 500 ms default budget); all
 * judgment happens in the supervised service's tick. One TaskObserver per ROOT task —
 * a subtask's activity is dropped except its spawn (the parent's new_task call) and
 * its conclusion (the child's attempt_completion), attributed via ctx.rootTaskId.
 * Everything is inert until the billed-AI consent: `isReady` gates every hook, the
 * service does nothing, and no advisory can exist.
 */

import type { PluginContext, ShoferPlugin } from "@shofer/types"
import { isIdleAsk, type ShoferAsk } from "@shofer/types"

import { STATUS_INTERVAL_MS, TICK_MS, type Observation, type StatusSnapshot, type TokenUsage } from "./types.js"
import {
	looksLikeError,
	projectAsk,
	projectNarration,
	projectSubtaskFinal,
	projectToolCall,
	projectToolError,
	projectUserMessage,
} from "./projection.js"
import { CATALOGUE_CONFIG_KEY, loadCatalogue } from "./catalogue.js"
import { CollisionIndex } from "./collisions.js"
import { LedgerStore } from "./ledger.js"
import { ForkLlmClient } from "./llm.js"
import { ForkToolExecutor } from "./tool-executor.js"
import { TaskObserver, type DeliverySeams, type ObserverTunables } from "./task-observer.js"

/** Tools whose call means a workspace file is being mutated (collision touches). */
const EDIT_TOOLS = new Set([
	"write_to_file",
	"apply_diff",
	"insert_edit",
	"sed",
	"edit_file",
	"search_replace",
	"edit",
	"apply_patch",
	"insert_content",
	"search_and_replace",
])

const STATUS_PATH = "status.json"

interface PluginState {
	ctx?: PluginContext
	observers: Map<string, TaskObserver>
	collisions: CollisionIndex
	ledgers?: LedgerStore
	clients: Map<string, ForkLlmClient>
	lastStatusWriteAt: number
	lastSweepAt: number
}

const state: PluginState = {
	observers: new Map(),
	collisions: new CollisionIndex(),
	clients: new Map(),
	lastStatusWriteAt: 0,
	lastSweepAt: 0,
}

function isReady(ctx: PluginContext): boolean {
	return ctx.ai?.hasConsent() ?? false
}

function cfg(ctx: PluginContext): Record<string, unknown> {
	return ctx.config ?? {}
}

function num(ctx: PluginContext, key: string, fallback: number): number {
	const v = cfg(ctx)[key]
	return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

function bool(ctx: PluginContext, key: string, fallback: boolean): boolean {
	const v = cfg(ctx)[key]
	return typeof v === "boolean" ? v : fallback
}

function tunables(ctx: PluginContext): ObserverTunables {
	return {
		minIntervalS: num(ctx, "minIntervalS", 90),
		triggerChars: num(ctx, "triggerChars", 6000),
		maxIntervalS: num(ctx, "maxIntervalS", 300),
		forkDeadlineS: num(ctx, "forkDeadlineS", 20),
		tokensPerTask: num(ctx, "tokensPerTask", 2_000_000),
		tokensPerHour: num(ctx, "tokensPerHour", 600_000),
		finishGateEnabled: bool(ctx, "finishGateEnabled", true),
		finishGateMinIntervalS: num(ctx, "finishGateMinIntervalS", 3600),
		turnEndReport: bool(ctx, "turnEndReport", true),
		gate: {
			ratePerHour: num(ctx, "ratePerHour", 4),
			cooldownS: num(ctx, "cooldownS", 300),
			humanFloor: num(ctx, "humanFloor", 0.35),
			adviceTtlS: num(ctx, "adviceTtlS", 900),
			queueTimeoutS: num(ctx, "queueTimeoutS", 1800),
			muted: bool(ctx, "mute", false),
		},
	}
}

function log(ctx: PluginContext, message: string): void {
	try {
		ctx.host?.log.info(message)
	} catch {
		// Logging must never break a hook.
	}
}

/** The root task an event belongs to — subtask events attribute to their root. */
function rootOf(ctx: PluginContext): string | undefined {
	return ctx.rootTaskId ?? ctx.taskId
}

function seamsFor(ctx: PluginContext, taskId: string): DeliverySeams {
	return {
		async notifyAgent(text) {
			await ctx.agent?.notify(text, { mode: "notify", taskId, source: "second-brain" })
		},
		async queueAgent(text) {
			await ctx.agent?.notify(text, { mode: "queue", taskId })
		},
		async marker(kind, text, data) {
			try {
				await ctx.task?.marker({ kind, text, data, taskId })
			} catch {
				// A detached UI must never break the observer.
			}
		},
		async loadDetectors() {
			// Read from ctx.config each pass: a Settings edit or an org bundle change
			// reloads the plugin with a fresh context, so this is always current.
			return loadCatalogue(cfg(ctx)[CATALOGUE_CONFIG_KEY], (m) => log(ctx, m))
		},
		clientFor(provider) {
			const key = provider ?? (cfg(ctx).profileRef as string) ?? ""
			let client = state.clients.get(key)
			if (!client && ctx.ai) {
				client = new ForkLlmClient(ctx.ai, key || undefined)
				state.clients.set(key, client)
			}
			if (!client) throw new Error("second-brain: ctx.ai unavailable")
			return client
		},
		executor() {
			return new ForkToolExecutor(ctx, ctx.cwd ?? ctx.workspacePath)
		},
		tunables() {
			return tunables(ctx)
		},
		async debugCapture(capturedTaskId, pass, name, content) {
			if (!bool(ctx, "debug", false)) return
			try {
				await ctx.storage?.writeFile(`debug/${capturedTaskId}/${pass}/${name}.txt`, content)
			} catch {
				// Debug capture is best-effort.
			}
		},
		log(message) {
			log(ctx, `second-brain: ${message}`)
		},
	}
}

function observerFor(ctx: PluginContext, taskId: string | undefined): TaskObserver | undefined {
	if (!taskId || !isReady(ctx)) return undefined
	let observer = state.observers.get(taskId)
	if (!observer) {
		if (!ctx.storage) return undefined
		state.ledgers ??= new LedgerStore(ctx.storage)
		observer = new TaskObserver(taskId, ctx.cwd ?? ctx.workspacePath, state.ledgers, seamsFor(ctx, taskId))
		state.observers.set(taskId, observer)
	}
	return observer
}

function observe(ctx: PluginContext, taskId: string | undefined, o: Omit<Observation, "at">): void {
	const observer = observerFor(ctx, taskId)
	if (!observer) return
	observer.observe({ ...o, at: Date.now() })
}

async function writeStatus(ctx: PluginContext, now: number): Promise<void> {
	const snapshot: StatusSnapshot = {
		version: 1,
		updatedAt: now,
		muted: bool(ctx, "mute", false),
		consent: isReady(ctx),
		tasks: [...state.observers.values()].map((o) => o.stats),
	}
	try {
		await ctx.storage?.writeFile(STATUS_PATH, JSON.stringify(snapshot))
	} catch {
		// Status is reporting, never gating.
	}
	pushUiState(ctx, snapshot)
}

function pushUiState(ctx: PluginContext, snapshot: StatusSnapshot): void {
	try {
		ctx.ui?.postMessage({ type: "state", snapshot })
	} catch {
		// A detached webview can never break the loop.
	}
}

const plugin: ShoferPlugin = {
	name: "second-brain",

	initialize(ctx: PluginContext) {
		// A config edit reloads the plugin with a fresh ctx: reset the process-lived
		// pieces that captured the old one. Observers persist judgment in ledgers, so
		// dropping the in-memory set costs the warm digests, not the durable state.
		state.ctx = ctx
		state.clients.clear()
		state.observers.clear()
		if (ctx.storage) state.ledgers = new LedgerStore(ctx.storage)

		// The supervised pass loop — the monitor's replacement in the Shofer port.
		if (ctx.registerService) {
			let timer: ReturnType<typeof setInterval> | undefined
			ctx.registerService({
				name: "second-brain-observer",
				start: () => {
					timer = setInterval(() => {
						void tick(ctx).catch(() => {})
					}, TICK_MS)
					// The tick must never hold the process open (headless exit).
					timer.unref?.()
				},
				stop: () => {
					if (timer) clearInterval(timer)
				},
			})
		}
	},

	lifecycle: {
		beforeTaskStart(taskCtx) {
			const ctx = { ...(state.ctx ?? {}), ...taskCtx }
			// Only root tasks get observers; a subtask's spawn is already visible as the
			// parent's new_task call, and its conclusion arrives via attempt_completion.
			if (taskCtx.parentTaskId) return
			const observer = observerFor(ctx, taskCtx.taskId)
			if (!observer) return
			if (taskCtx.prompt) {
				observer.noteGoal(taskCtx.prompt)
				observer.observe({ ...projectUserMessage(taskCtx.prompt), at: Date.now(), kind: "user" })
			}
		},

		onAssistantMessage(info, hookCtx) {
			const ctx = { ...(state.ctx ?? {}), ...hookCtx }
			if (hookCtx.parentTaskId) return // subtask narration is dropped by contract
			observe(ctx, info.taskId, projectNarration(info.text))
		},

		onUserMessage(info, hookCtx) {
			const ctx = { ...(state.ctx ?? {}), ...hookCtx }
			if (hookCtx.parentTaskId) return
			if (info.text) observe(ctx, info.taskId, projectUserMessage(info.text))
		},

		beforeToolCall(toolName, args, hookCtx) {
			const ctx = { ...(state.ctx ?? {}), ...hookCtx }
			const taskId = hookCtx.taskId
			const root = rootOf(hookCtx)
			const now = Date.now()

			// A child's conclusion is the one child event the root observer keeps.
			if (hookCtx.parentTaskId && taskId && root && toolName === "attempt_completion") {
				observe(ctx, root, projectSubtaskFinal(taskId, String((args as Record<string, unknown>).result ?? "")))
				return { allow: true }
			}
			if (hookCtx.parentTaskId) return { allow: true }

			observe(ctx, taskId, projectToolCall(toolName, args as Record<string, unknown>))

			// Collision awareness: structural, computed here, judged by no model.
			if (taskId && EDIT_TOOLS.has(toolName)) {
				const a = args as Record<string, unknown>
				const path = String(a.path ?? a.file_path ?? a.filePath ?? "")
				if (path) {
					const collisions = state.collisions.check(taskId, path, hookCtx.cwd, now)
					state.collisions.touch(taskId, path, hookCtx.cwd, now)
					if (collisions.length) observerFor(ctx, root)?.noteCollisions(collisions)
				}
			}
			return { allow: true }
		},

		afterToolCall(toolName, _args, result, hookCtx) {
			const ctx = { ...(state.ctx ?? {}), ...hookCtx }
			if (hookCtx.parentTaskId) return
			// Successful results are DROPPED — the whole economics. Errors keep a head.
			if (typeof result === "string" && result && looksLikeError(result)) {
				observe(ctx, hookCtx.taskId, projectToolError(toolName, result))
			}
		},

		beforeAsk(askType, payload, hookCtx) {
			const ctx = { ...(state.ctx ?? {}), ...hookCtx }
			if (hookCtx.parentTaskId) return
			const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "")
			observe(ctx, hookCtx.taskId, projectAsk(askType, text))
			// An idle-class ask is the turn ending — the always-runs pass trigger.
			if (isIdleAsk(askType as ShoferAsk)) {
				observerFor(ctx, rootOf(hookCtx))?.noteTurnEnd(false)
			}
			return undefined
		},

		afterTaskComplete(taskCtx) {
			const ctx = { ...(state.ctx ?? {}), ...taskCtx }
			if (taskCtx.parentTaskId) {
				state.collisions.forget(taskCtx.taskId ?? "")
				return
			}
			const observer = observerFor(ctx, taskCtx.taskId)
			if (!observer) return
			observer.observe({
				at: Date.now(),
				kind: "task",
				text: `task ${taskCtx.reason === "completed" ? "completed" : "aborted"}`,
			})
			observer.noteTurnEnd(taskCtx.reason === "completed")
			if (taskCtx.taskId) state.collisions.forget(taskCtx.taskId)
		},

		onTaskDeleted(info) {
			state.observers.delete(info.taskId)
			state.collisions.forget(info.taskId)
			void state.ledgers?.delete(info.taskId)
		},
	},

	async handleRequest(method, params, ctx) {
		const p = (params ?? {}) as Record<string, unknown>
		switch (method) {
			case "getState": {
				try {
					const raw = await ctx.storage?.readFile(STATUS_PATH)
					return raw ? (JSON.parse(raw) as StatusSnapshot) : undefined
				} catch {
					return undefined
				}
			}
			case "stats": {
				const debugOn = bool(ctx, "debug", false)
				return {
					consent: isReady(ctx),
					muted: bool(ctx, "mute", false),
					catalogueKey: `pluginConfigs["second-brain"].${CATALOGUE_CONFIG_KEY}`,
					// Where the per-pass digest.txt / pass.json / <detector>.txt land when
					// `debug` is on — undiscoverable otherwise, since it is the plugin's
					// private storage rather than a path the user chose.
					debug: debugOn
						? { enabled: true, dir: `${ctx.storage?.dir ?? "<plugin storage>"}/debug` }
						: { enabled: false },
					tasks: [...state.observers.values()].map((o) => ({
						...o.stats,
						// Cache efficiency, from the provider's own usage numbers: at steady
						// state cacheRead should dominate prompt as the digest grows.
						cacheHitRatio: cacheHitRatio(o.stats.tokens),
						uptake: uptakeOf(o),
					})),
				}
			}
			case "why": {
				const taskId = typeof p.taskId === "string" ? p.taskId : undefined
				const observers = taskId
					? [state.observers.get(taskId)].filter((o): o is TaskObserver => !!o)
					: [...state.observers.values()]
				return observers.map((o) => ({
					taskId: o.taskId,
					advisories: o.currentLedger?.advisories.slice(-10) ?? [],
					drops: o.currentLedger?.drops.slice(-10) ?? [],
				}))
			}
			case "run": {
				const taskId = typeof p.taskId === "string" ? p.taskId : [...state.observers.keys()].pop()
				const observer = taskId ? state.observers.get(taskId) : undefined
				if (!observer) return { error: "no observed task" }
				const result = await observer.runPass("manual", () => Date.now())
				return result ?? { error: "pass did not run (in flight, or nothing to judge)" }
			}
			case "forget": {
				const taskId = typeof p.taskId === "string" ? p.taskId : undefined
				if (taskId) {
					state.observers.delete(taskId)
					await state.ledgers?.delete(taskId)
					return { forgot: taskId }
				}
				const all = (await state.ledgers?.list()) ?? []
				for (const id of all) await state.ledgers?.delete(id)
				state.observers.clear()
				return { forgot: all.length }
			}
			default:
				throw new Error(`second-brain: unknown request "${method}"`)
		}
	},

	onUiMessage(message, ctx) {
		const m = message as { command?: string }
		if (m?.command === "ready" || m?.command === "getState") {
			void writeStatus(ctx, Date.now())
		}
	},
}

/**
 * Share of billable input tokens that came from the cache. 1.0 means every prompt token
 * was a cached read; 0 means the fan-out is paying full price for the digest every time
 * (which is what a broken shared prefix looks like from the outside).
 */
function cacheHitRatio(tokens: TokenUsage): number {
	const billableInput = tokens.prompt + tokens.cacheRead + tokens.cacheWrite
	return billableInput === 0 ? 0 : tokens.cacheRead / billableInput
}

function uptakeOf(observer: TaskObserver): Record<string, { delivered: number; adopted: number }> {
	const byDetector: Record<string, { delivered: number; adopted: number }> = {}
	for (const a of observer.currentLedger?.advisories ?? []) {
		const entry = (byDetector[a.detector] ??= { delivered: 0, adopted: 0 })
		if (a.deliveredAt) entry.delivered++
		if (a.outcome?.verdict === "adopted" || a.outcome?.verdict === "partially_adopted") entry.adopted++
	}
	return byDetector
}

/** One service tick: run due passes, sweep, keep the status snapshot fresh. */
async function tick(ctx: PluginContext): Promise<void> {
	if (!isReady(ctx) || bool(ctx, "mute", false)) return
	const now = Date.now()
	for (const observer of state.observers.values()) {
		const trigger = observer.dueTrigger(now)
		if (trigger) {
			await observer.runPass(trigger, () => Date.now())
			await writeStatus(ctx, Date.now())
		}
	}
	state.collisions.compact(now)
	if (now - state.lastStatusWriteAt > STATUS_INTERVAL_MS) {
		state.lastStatusWriteAt = now
		await writeStatus(ctx, now)
	}
	if (now - state.lastSweepAt > 3600 * 1000) {
		state.lastSweepAt = now
		await state.ledgers?.sweep(now, new Set(state.observers.keys()))
	}
}

export default plugin
