import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as vscode from "vscode"

import type {
	AgentApi,
	GlobalSettings,
	LoadSample,
	ServerEvent,
	ShoferAPI,
	ShoferWorkerConnState,
	SyncedPluginState,
} from "@shofer/types"
import {
	LOCAL_WORKER_ID,
	ShoferEventName,
	TypedEmitter,
	computeConfigVersion,
	defaultModeSlug,
	pickSyncedSecrets,
	pickSyncedSettings,
} from "@shofer/types"

import {
	WorkerRegistry,
	type IWorkerConnection,
	type WorkerConnectionFactory,
	type PluginSyncSource,
	type SyncedConfigSource,
} from "../WorkerRegistry.js"

/**
 * Controller-side registry (Shofer Workers L1). Driven with an in-memory
 * ExtensionContext stub (globalState + secrets) and a fake WorkerConnection, so
 * persistence, pool population, and the pushed view model are all deterministic.
 */

/** The L3 reverse-data-channel stub shared by the agent mocks below. */
function l3Stubs() {
	return {
		pluginRequest: vi.fn(async () => null),
	}
}

function makeAgent(): AgentApi {
	return {
		createTask: vi.fn(async () => ({ taskId: "t" })),
		sendMessage: vi.fn(async () => {}),
		cancelTask: vi.fn(async () => {}),
		respondToAsk: vi.fn(async () => {}),
		applyConfig: vi.fn(async () => {}),
		...l3Stubs(),
		subscribe: vi.fn(() => () => {}),
	}
}

/** In-memory ExtensionContext (only the bits the registry touches). */
function makeContext() {
	const globals = new Map<string, unknown>()
	const secrets = new Map<string, string>()
	const context = {
		globalState: {
			get: (k: string) => globals.get(k),
			update: async (k: string, v: unknown) => {
				globals.set(k, v)
			},
		},
		secrets: {
			get: async (k: string) => secrets.get(k),
			store: async (k: string, v: string) => {
				secrets.set(k, v)
			},
			delete: async (k: string) => {
				secrets.delete(k)
			},
		},
	} as unknown as vscode.ExtensionContext
	return { context, globals, secrets }
}

/** A drivable fake connection satisfying IWorkerConnection. */
class FakeConn implements IWorkerConnection {
	status: ShoferWorkerConnState = "disconnected"
	latencyMs?: number
	agentVersion?: string
	error?: string
	load: LoadSample | undefined
	configVersion: string | undefined
	managed = true
	api: AgentApi | undefined
	disposed = false
	private cbs = new Set<(s: ShoferWorkerConnState) => void>()

	constructor(readonly opts: { baseUrl: string; token?: string; controllerVersion: string }) {}

	markConfigApplied(version: string): void {
		this.configVersion = version
	}
	onStatusChange(cb: (s: ShoferWorkerConnState) => void): () => void {
		this.cbs.add(cb)
		return () => this.cbs.delete(cb)
	}
	async connect(): Promise<void> {
		this.set("connecting")
	}
	disconnect(): void {
		this.api = undefined
		this.set("disconnected")
	}
	dispose(): void {
		this.disposed = true
		this.disconnect()
	}
	/** Test helper: transition and (optionally) set the live api. */
	drive(
		status: ShoferWorkerConnState,
		extra: Partial<Pick<FakeConn, "api" | "latencyMs" | "agentVersion" | "error" | "load">> = {},
	): void {
		Object.assign(this, extra)
		this.set(status)
	}
	private set(s: ShoferWorkerConnState): void {
		this.status = s
		for (const cb of [...this.cbs]) cb(s)
	}
}

function makeRegistry(seedDefs?: unknown[], configSource?: SyncedConfigSource, pluginSyncSource?: PluginSyncSource) {
	const { context, globals, secrets } = makeContext()
	if (seedDefs) globals.set("shoferWorkers.defs", seedDefs)
	const conns = new Map<string, FakeConn>()
	const createConnection: WorkerConnectionFactory = (o) => {
		const c = new FakeConn(o)
		conns.set(o.baseUrl, c)
		return c
	}
	const localAgent = makeAgent()
	const registry = new WorkerRegistry(
		{ context, localApi: {} as ShoferAPI, controllerVersion: "1.0.0", configSource, pluginSyncSource },
		{ createConnection, localAgent },
	)
	return { registry, globals, secrets, conns, localAgent }
}

/**
 * A drivable fake {@link SyncedConfigSource} (config_sync §4c). `getValues` returns a
 * live, mutable slice (default: one auto-approval key + one command allowlist key, both
 * worker-scoped so `pickSyncedSettings` yields a non-empty slice) and `onDidChange` is a
 * real {@link TypedEmitter} the test fires. `slice()`/`version()` mirror what the registry
 * resolves internally so assertions can compare against the exact pushed payload.
 */
function makeConfigSource(initial: Partial<GlobalSettings> = { allowedCommands: ["ls"], autoApprovalEnabled: true }) {
	let values: Partial<GlobalSettings> = { ...initial }
	let secrets: Partial<Record<string, string>> = {}
	const emitter = new TypedEmitter<{ key: string }>()
	const source: SyncedConfigSource = {
		getValues: () => values,
		getSecret: (key) => secrets[key],
		onDidChange: emitter.event,
	}
	return {
		source,
		setValues: (v: Partial<GlobalSettings>) => {
			values = { ...v }
		},
		setSecret: (key: string, value: string | undefined) => {
			secrets = { ...secrets, [key]: value }
		},
		fire: (key: string) => emitter.fire({ key }),
		slice: () => pickSyncedSettings(values),
		secrets: () => pickSyncedSecrets(secrets),
		version: (plugins: SyncedPluginState = {}) =>
			computeConfigVersion(pickSyncedSettings(values), pickSyncedSecrets(secrets), plugins),
	}
}

/** A drivable {@link PluginSyncSource} — the plugin half of the controller's slice. */
function makePluginSyncSource(initial: SyncedPluginState = {}) {
	let slice: SyncedPluginState = initial
	const emitter = new TypedEmitter<void>()
	const source: PluginSyncSource = {
		currentPluginSlice: async () => slice,
		onDidChange: emitter.event,
	}
	return {
		source,
		set: (next: SyncedPluginState) => {
			slice = next
		},
		fire: () => emitter.fire(undefined),
		slice: () => slice,
	}
}

/** A fake {@link WorkerProviderHost} recording the in-process Local new-task path. */
function makeProviderHost() {
	let seq = 0
	let currentTaskId: string | undefined
	const host = {
		createManagedTask: vi.fn(async () => {
			currentTaskId = `local-task-${++seq}`
			return currentTaskId
		}),
		getCurrentTask: () => (currentTaskId ? { taskId: currentTaskId } : undefined),
		postMessageToWebview: vi.fn(async (_msg: unknown) => {}),
		postInitState: vi.fn(async () => {}),
	}
	return host
}

/** An {@link AgentApi} whose event stream is drivable (for the pool-feed demux). */
function makeDrivableAgent(taskId: string) {
	let emit: (e: ServerEvent) => void = () => {}
	const api: AgentApi = {
		createTask: vi.fn(async () => ({ taskId })),
		sendMessage: vi.fn(async () => {}),
		cancelTask: vi.fn(async () => {}),
		respondToAsk: vi.fn(async () => {}),
		applyConfig: vi.fn(async () => {}),
		...l3Stubs(),
		subscribe: (listener) => {
			emit = listener
			return () => {
				emit = () => {}
			}
		},
	}
	return { api, emit: (e: ServerEvent) => emit(e) }
}

const msg = (ts: number, over: Partial<import("@shofer/types").ShoferMessage> = {}) => ({
	ts,
	type: "say" as const,
	text: `m${ts}`,
	...over,
})

const remoteDef = { id: "r1", kind: "remote" as const, label: "box", host: "host:1", tls: false }

describe("WorkerRegistry (Shofer Workers L1)", () => {
	let h: ReturnType<typeof makeRegistry>

	beforeEach(() => {
		h = makeRegistry()
	})

	it("registers Local at construction and reports it running", () => {
		const state = h.registry.getState()
		expect(state.activeWorkerId).toBe(LOCAL_WORKER_ID)
		expect(state.workers).toHaveLength(1)
		expect(state.workers[0]).toMatchObject({
			id: LOCAL_WORKER_ID,
			kind: "local",
			status: "running",
			isActive: true,
			disabled: false,
			agentVersion: "1.0.0",
		})
		expect(h.registry.executorPool.has(LOCAL_WORKER_ID)).toBe(true)
	})

	it("upsert persists a remote def + token, surfaces hasToken (no secret leak)", async () => {
		let changed = 0
		h.registry.onChange(() => changed++)
		await h.registry.upsert(remoteDef, "s3cret")

		expect(changed).toBe(1)
		expect(h.secrets.get("shoferWorker.token.r1")).toBe("s3cret")
		expect(h.globals.get("shoferWorkers.defs")).toContainEqual(
			expect.objectContaining({ id: "r1", kind: "remote" }),
		)

		const view = h.registry.getState().workers.find((n) => n.id === "r1")!
		expect(view).toMatchObject({ id: "r1", status: "disconnected", hasToken: true, disabled: false })
		expect(view).not.toHaveProperty("token")
	})

	it("connect() sets autoConnect, and a connected worker joins the pool", async () => {
		await h.registry.upsert(remoteDef)
		await h.registry.connect("r1")

		// Still connecting → not yet pooled.
		expect(h.registry.executorPool.has("r1")).toBe(false)
		expect(h.registry.getState().workers.find((n) => n.id === "r1")!.status).toBe("connecting")

		// Drive to connected with a live api → the registry adds it to the pool.
		const api = makeAgent()
		h.conns.get("http://host:1")!.drive("connected", { api, latencyMs: 12, agentVersion: "1.0.0" })

		expect(h.registry.executorPool.has("r1")).toBe(true)
		const view = h.registry.getState().workers.find((n) => n.id === "r1")!
		expect(view).toMatchObject({ status: "connected", latencyMs: 12, agentVersion: "1.0.0" })
		const savedR1 = (h.globals.get("shoferWorkers.defs") as any[]).find((d) => d.id === "r1")
		expect(savedR1).toMatchObject({ id: "r1", autoConnect: true })
	})

	it("a connected worker dropping to reconnecting leaves the pool", async () => {
		await h.registry.upsert(remoteDef)
		await h.registry.connect("r1")
		const conn = h.conns.get("http://host:1")!
		conn.drive("connected", { api: makeAgent() })
		expect(h.registry.executorPool.has("r1")).toBe(true)

		conn.drive("reconnecting", { api: undefined, error: "timeout" })
		expect(h.registry.executorPool.has("r1")).toBe(false)
		expect(h.registry.getState().workers.find((n) => n.id === "r1")!.status).toBe("reconnecting")
	})

	it("disconnect() clears autoConnect, tears down, and removes from the pool", async () => {
		await h.registry.upsert(remoteDef)
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: makeAgent() })

		await h.registry.disconnect("r1")
		expect(h.registry.executorPool.has("r1")).toBe(false)
		const saved = (h.globals.get("shoferWorkers.defs") as any[]).find((d) => d.id === "r1")
		expect(saved).toMatchObject({ id: "r1", autoConnect: false })
		expect(h.registry.getState().workers.find((n) => n.id === "r1")!.status).toBe("disconnected")
	})

	it("setDisabled(remote) disconnects a connected worker; setDisabled(local) toggles pool", async () => {
		await h.registry.upsert(remoteDef)
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: makeAgent() })

		await h.registry.setDisabled("r1", true)
		expect(h.registry.executorPool.has("r1")).toBe(false)
		expect(h.registry.getState().workers.find((n) => n.id === "r1")!.disabled).toBe(true)

		// Local can be disabled too.
		await h.registry.setDisabled(LOCAL_WORKER_ID, true)
		const local = h.registry.getState().workers.find((n) => n.id === LOCAL_WORKER_ID)!
		expect(local).toMatchObject({ status: "disconnected", disabled: true })
	})

	it("refuses to remove Local, removes a remote (def + token gone)", async () => {
		await h.registry.upsert(remoteDef, "tok")
		await h.registry.remove(LOCAL_WORKER_ID)
		expect(h.registry.getState().workers.some((n) => n.id === LOCAL_WORKER_ID)).toBe(true)

		await h.registry.remove("r1")
		expect(h.registry.getState().workers.some((n) => n.id === "r1")).toBe(false)
		expect(h.secrets.get("shoferWorker.token.r1")).toBeUndefined()
		expect(h.globals.get("shoferWorkers.defs")).toEqual([expect.objectContaining({ id: LOCAL_WORKER_ID })])
	})

	// ── L2: routeNewTask + recursion guard ──────────────────────────────────────

	it("routeNewTask on a Local pick runs the IN-PROCESS path exactly once (no re-entry through the pool)", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)

		// Only Local is registered → owner is always Local.
		const taskId = await h.registry.routeNewTask({ prompt: "hello" })

		expect(host.createManagedTask).toHaveBeenCalledTimes(1)
		expect(host.createManagedTask).toHaveBeenCalledWith(undefined, "hello", undefined, undefined, {
			mode: undefined,
			apiConfigName: undefined,
		})
		// The recursion guard: the pool's Local executor createTask must NEVER be
		// called (that path leads back through api.startNewTask → provider.createTask).
		expect(h.localAgent.createTask).not.toHaveBeenCalled()
		// Ownership is still recorded as Local so activeWorkerId() reports Local.
		expect(taskId).toBe("local-task-1")
		expect(h.registry.executorPool.ownerOf("local-task-1")).toBe(LOCAL_WORKER_ID)
	})

	it("hasEnabledRemote reflects assignable remotes; a preferredWorkerId=local routes in-process", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)
		expect(h.registry.hasEnabledRemote()).toBe(false)

		// Connect a remote → hasEnabledRemote true.
		await h.registry.upsert(remoteDef, "tok")
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: makeAgent() })
		expect(h.registry.hasEnabledRemote()).toBe(true)

		// preferredWorkerId=local pins the task to the in-process path even with a remote present.
		await h.registry.routeNewTask({ prompt: "pin-local", preferredWorkerId: LOCAL_WORKER_ID })
		expect(host.createManagedTask).toHaveBeenCalledTimes(1)
		expect(h.localAgent.createTask).not.toHaveBeenCalled()
	})

	it("routeNewTask refuses when Local is disabled and nothing else is assignable", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)

		await h.registry.setDisabled(LOCAL_WORKER_ID, true)
		expect(h.registry.isLocalDisabled()).toBe(true)

		// The pool has nothing assignable, so the bare LOCAL_WORKER_ID fallback is the
		// only candidate — the refusal must fire instead of an in-process run.
		await expect(h.registry.routeNewTask({ prompt: "nowhere-to-run" })).rejects.toThrow(
			/Local executor is disabled and no remote worker is available/,
		)
		expect(host.createManagedTask).not.toHaveBeenCalled()
	})

	it("routeNewTask with Local disabled still routes to an assignable remote", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)
		const remoteApi = makeAgent()
		;(remoteApi.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({ taskId: "r1-task-1" })

		await h.registry.setDisabled(LOCAL_WORKER_ID, true)
		await h.registry.upsert(remoteDef, "tok")
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: remoteApi })

		// Round-robin has exactly one assignable executor (the remote) — no throw.
		const taskId = await h.registry.routeNewTask({ prompt: "remote-only" })
		expect(remoteApi.createTask).toHaveBeenCalledWith({ prompt: "remote-only", mode: defaultModeSlug })
		expect(host.createManagedTask).not.toHaveBeenCalled()
		expect(taskId).toBe("r1-task-1")
	})

	it("routeNewTask on a remote owner dispatches through the pool (never the in-process path)", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)
		const remoteApi = makeAgent()
		;(remoteApi.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({ taskId: "r1-task-1" })

		await h.registry.upsert(remoteDef, "tok")
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: remoteApi })

		// Force the remote owner via preferredWorkerId (deterministic, no RR dependence).
		const taskId = await h.registry.routeNewTask({ prompt: "remote-run", preferredWorkerId: "r1" })
		expect(remoteApi.createTask).toHaveBeenCalledWith({ prompt: "remote-run", mode: defaultModeSlug })
		expect(host.createManagedTask).not.toHaveBeenCalled()
		expect(taskId).toBe("r1-task-1")
		expect(h.registry.executorPool.ownerOf("r1-task-1")).toBe("r1")
	})

	// ── L2: pool-feed demux → webview render ─────────────────────────────────────

	it("demuxes a remote Message created/updated sequence into append/update webview posts", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)
		const remote = makeDrivableAgent("r1-task-1")

		await h.registry.upsert(remoteDef, "tok")
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: remote.api })

		// routeNewTask(remote) creates + FOCUSES the shadow so deltas mirror to the webview.
		const taskId = await h.registry.routeNewTask({ prompt: "go", preferredWorkerId: "r1" })
		expect(taskId).toBe("r1-task-1")
		host.postMessageToWebview.mockClear()

		// created → shoferMessageAppended
		remote.emit({ type: ShoferEventName.Message, args: [{ taskId, action: "created", message: msg(1) }] })
		// updated → messageUpdated
		remote.emit({
			type: ShoferEventName.Message,
			args: [{ taskId, action: "updated", message: msg(1, { text: "m1!" }) }],
		})

		const posts = host.postMessageToWebview.mock.calls.map(
			(c) => c[0] as { type: string; shoferMessage: { ts: number; text?: string } },
		)
		const renderPosts = posts.filter((p) => p.type === "shoferMessageAppended" || p.type === "messageUpdated")
		expect(renderPosts).toEqual([
			{ type: "shoferMessageAppended", shoferMessage: msg(1) },
			{ type: "messageUpdated", shoferMessage: msg(1, { text: "m1!" }) },
		])

		// The shadow buffer reflects the in-place update by ts (no duplicate).
		const shadow = h.registry.getFocusedShadow(host)!
		expect(shadow.messages).toEqual([msg(1, { text: "m1!" })])
	})

	it("routes respondToAsk for a shadow task to the owning executor (reverse ask channel)", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)
		const remote = makeDrivableAgent("r1-task-1")
		await h.registry.upsert(remoteDef, "tok")
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: remote.api })

		const taskId = await h.registry.routeNewTask({ prompt: "go", preferredWorkerId: "r1" })
		expect(h.registry.isShadow(taskId!)).toBe(true)

		await h.registry.respondToAsk(taskId!, { askResponse: "yesButtonClicked", text: "ok", askId: "a1" })
		expect(remote.api.respondToAsk).toHaveBeenCalledWith("r1-task-1", {
			askResponse: "yesButtonClicked",
			text: "ok",
			askId: "a1",
		})

		// A local task is never a shadow.
		expect(h.registry.isShadow("local-task-99")).toBe(false)
	})

	it("routes a plugin request for a shadow task to the owning executor", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)
		const remote = makeDrivableAgent("r1-task-1")
		await h.registry.upsert(remoteDef, "tok")
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: remote.api })

		const taskId = await h.registry.routeNewTask({ prompt: "go", preferredWorkerId: "r1" })
		expect(h.registry.isShadow(taskId!)).toBe(true)
		const rec = remote.api as unknown as Record<string, ReturnType<typeof vi.fn>>

		// Every plugin-owned per-task feature (checkpoints, the change list, …) reaches
		// the executor through this one call, addressed by the REMOTE task id.
		await h.registry.pluginRequest(taskId!, "checkpoints", "restore", { hash: "c1" })
		expect(rec.pluginRequest).toHaveBeenCalledWith("r1-task-1", "checkpoints", "restore", { hash: "c1" })
	})

	it("rebuildShadow clears the buffered conversation and re-posts init state", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)
		const remote = makeDrivableAgent("r1-task-1")
		await h.registry.upsert(remoteDef, "tok")
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: remote.api })
		const taskId = await h.registry.routeNewTask({ prompt: "go", preferredWorkerId: "r1" })

		// Buffer a message, then rebuild.
		remote.emit({
			type: ShoferEventName.Message,
			args: [{ taskId, action: "created", message: { ts: 10, say: "text", text: "hi" } }],
		})
		expect(h.registry.getFocusedShadow(host)!.messages).toHaveLength(1)
		host.postInitState.mockClear()

		await h.registry.rebuildShadow(taskId!)

		// The executor re-emits its post-rewind stream, which repopulates the shadow.
		expect(h.registry.getFocusedShadow(host)!.messages).toHaveLength(0)
		expect(host.postInitState).toHaveBeenCalled()
	})

	it("carries remote token usage onto the shadow's header summary (full-fidelity meter)", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)
		const remote = makeDrivableAgent("r1-task-1")
		await h.registry.upsert(remoteDef, "tok")
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: remote.api })
		const taskId = await h.registry.routeNewTask({ prompt: "go", preferredWorkerId: "r1" })

		// Before any usage event, the summary is zeroed.
		expect(h.registry.getFocusedShadow(host)!.toTaskItem()).toMatchObject({
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		})

		remote.emit({
			type: ShoferEventName.TaskTokenUsageUpdated,
			args: [taskId, { totalTokensIn: 1200, totalTokensOut: 340, totalCost: 0.05, contextTokens: 1540 }, {}],
		})

		expect(h.registry.getFocusedShadow(host)!.toTaskItem()).toMatchObject({
			tokensIn: 1200,
			tokensOut: 340,
			totalCost: 0.05,
		})
	})

	it("drops Local-tagged pool events (no shadow, no webview render posts)", async () => {
		// A registry whose LOCAL agent is drivable, so we can emit a Local-tagged event.
		const { context } = makeContext()
		const localDrivable = makeDrivableAgent("local-1")
		const registry = new WorkerRegistry(
			{ context, localApi: {} as ShoferAPI, controllerVersion: "1.0.0" },
			{ localAgent: localDrivable.api },
		)
		const host = makeProviderHost()
		registry.attachProvider(host)

		// Even a Message tagged with the Local executor must be ignored by the demux.
		localDrivable.emit({
			type: ShoferEventName.Message,
			args: [{ taskId: "local-1", action: "created", message: msg(1) }],
		})
		localDrivable.emit({ type: ShoferEventName.TaskCompleted, args: ["local-1"] })

		expect(host.postMessageToWebview).not.toHaveBeenCalled()
		expect(registry.getFocusedShadow(host)).toBeUndefined()
	})

	it("buffers a non-auto-approved remote ask + mirrors it to the webview (interactive approval)", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)
		const remote = makeDrivableAgent("r1-task-1")
		await h.registry.upsert(remoteDef, "tok")
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: remote.api })
		const taskId = await h.registry.routeNewTask({ prompt: "go", preferredWorkerId: "r1" })
		host.postMessageToWebview.mockClear()

		const askMessage = msg(2, { type: "ask", ask: "command", autoApproved: false })
		remote.emit({ type: ShoferEventName.Message, args: [{ taskId, action: "created", message: askMessage }] })

		// The ask is buffered like any other message (no "blocked" dead-end) and
		// mirrored to the webview so it can render normal approve/deny buttons.
		const shadow = h.registry.getFocusedShadow(host)!
		expect(shadow.messages).toContainEqual(askMessage)
		expect(host.postMessageToWebview).toHaveBeenCalledWith({
			type: "shoferMessageAppended",
			shoferMessage: askMessage,
		})
	})

	// ── L2: dynamic activeWorkerId + focus swaps ───────────────────────────────────

	it("activeWorkerId + isActive follow the focused task owner across a focus swap", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)
		const remote = makeDrivableAgent("r1-task-1")
		await h.registry.upsert(remoteDef, "tok")
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: remote.api })

		// Before any remote task: Local is active.
		expect(h.registry.getState().activeWorkerId).toBe(LOCAL_WORKER_ID)

		// Focus a remote shadow → the remote worker becomes active + isActive.
		await h.registry.routeNewTask({ prompt: "go", preferredWorkerId: "r1" })
		let state = h.registry.getState()
		expect(state.activeWorkerId).toBe("r1")
		expect(state.workers.find((n) => n.id === "r1")!.isActive).toBe(true)
		expect(state.workers.find((n) => n.id === LOCAL_WORKER_ID)!.isActive).toBe(false)

		// Swap focus back to a local task → Local active again.
		h.registry.clearShadowFocus(host)
		state = h.registry.getState()
		expect(state.activeWorkerId).toBe(LOCAL_WORKER_ID)
		expect(state.workers.find((n) => n.id === "r1")!.isActive).toBe(false)
	})

	// ── per-view shadow focus (the shadow-first non-clobber increment) ───────────

	it("focuses a shadow PER VIEW: focusing in one view leaves the other unaffected; deltas fan out only to focused views; detach clears focus", async () => {
		const a = makeProviderHost() // e.g. the sidebar
		const b = makeProviderHost() // e.g. a separate editor tab
		h.registry.attachProvider(a)
		h.registry.attachProvider(b)
		const remote = makeDrivableAgent("r1-task-1")
		await h.registry.upsert(remoteDef, "tok")
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: remote.api })

		// View B starts the remote task → only B focuses the new shadow; A is untouched.
		const taskId = await h.registry.routeNewTask({ prompt: "go", preferredWorkerId: "r1" }, b)
		expect(taskId).toBe("r1-task-1")
		expect(h.registry.getFocusedShadow(b)?.taskId).toBe("r1-task-1")
		expect(h.registry.getFocusedShadow(a)).toBeUndefined()

		a.postMessageToWebview.mockClear()
		b.postMessageToWebview.mockClear()

		// A remote Message delta posts ONLY to the focused view (B), never the
		// unfocused one (A) — the core non-clobber guarantee at the delta layer.
		remote.emit({ type: ShoferEventName.Message, args: [{ taskId, action: "created", message: msg(1) }] })
		expect(b.postMessageToWebview).toHaveBeenCalledWith({ type: "shoferMessageAppended", shoferMessage: msg(1) })
		expect(a.postMessageToWebview).not.toHaveBeenCalled()

		// Detaching B releases its focus; the shadow keeps buffering (for any future view).
		h.registry.detachProvider(b)
		expect(h.registry.getFocusedShadow(b)).toBeUndefined()
		b.postMessageToWebview.mockClear()
		remote.emit({ type: ShoferEventName.Message, args: [{ taskId, action: "created", message: msg(2) }] })
		expect(b.postMessageToWebview).not.toHaveBeenCalled()
		expect(h.registry.isShadow(taskId!)).toBe(true)
	})

	// ── L2/D: shared singleton + multi-provider ──────────────────────────────────

	it("getInstance returns the same shared registry; both attached providers get shoferWorkers", async () => {
		WorkerRegistry.resetInstance()
		const { context } = makeContext()
		const opts = { context, localApi: {} as ShoferAPI, controllerVersion: "1.0.0" }
		const a = WorkerRegistry.getInstance(opts, { localAgent: makeAgent() })!
		const b = WorkerRegistry.getInstance()! // no args → same instance
		expect(a).toBe(b)

		const sidebar = makeProviderHost()
		const tab = makeProviderHost()
		let sidebarPushes = 0
		let tabPushes = 0
		a.onChange(() => sidebarPushes++)
		a.onChange(() => tabPushes++)
		a.attachProvider(sidebar)
		a.attachProvider(tab)

		// A change fires ALL onChange listeners (both webviews get worker state).
		await a.setDisabled(LOCAL_WORKER_ID, true)
		expect(sidebarPushes).toBeGreaterThan(0)
		expect(tabPushes).toBeGreaterThan(0)
		WorkerRegistry.resetInstance()
	})

	it("routeNewTask(initiator) retargets the render provider (task renders where it started)", async () => {
		WorkerRegistry.resetInstance()
		const { context } = makeContext()
		const registry = WorkerRegistry.getInstance(
			{ context, localApi: {} as ShoferAPI, controllerVersion: "1.0.0" },
			{ localAgent: makeAgent() },
		)!
		const sidebar = makeProviderHost()
		const tab = makeProviderHost()
		registry.attachProvider(sidebar) // sidebar is the default render target
		registry.attachProvider(tab)

		// Task started from the editor tab → the Local path runs on the TAB provider.
		await registry.routeNewTask({ prompt: "from tab" }, tab)
		expect(tab.createManagedTask).toHaveBeenCalledTimes(1)
		expect(sidebar.createManagedTask).not.toHaveBeenCalled()

		// Detaching the tab re-points the render target back to the sidebar.
		registry.detachProvider(tab)
		await registry.routeNewTask({ prompt: "from sidebar" })
		expect(sidebar.createManagedTask).toHaveBeenCalledTimes(1)
		WorkerRegistry.resetInstance()
	})

	it("init() auto-connects persisted autoConnect remotes and hydrates hasToken", async () => {
		const seeded = makeRegistry([{ id: "r1", kind: "remote", label: "box", host: "host:1", autoConnect: true }])
		seeded.secrets.set("shoferWorker.token.r1", "tok")

		await seeded.registry.init()
		// A connection was created for the autoConnect remote.
		const conn = seeded.conns.get("http://host:1")
		expect(conn).toBeDefined()
		conn!.drive("connected", { api: makeAgent() })

		expect(seeded.registry.executorPool.has("r1")).toBe(true)
		const view = seeded.registry.getState().workers.find((n) => n.id === "r1")!
		expect(view).toMatchObject({ status: "connected", hasToken: true })
	})
})

describe("WorkerRegistry — load-average LB policy (Shofer Workers)", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("wires a live Local load sample (loadavg triple + cpu count)", () => {
		const { registry } = makeRegistry()
		const sample = registry.executorPool.loadOf(LOCAL_WORKER_ID)
		expect(sample).toBeDefined()
		expect(sample!.loadavg).toHaveLength(3)
		expect(sample!.loadavg.every((n) => typeof n === "number")).toBe(true)
		expect(sample!.cpus).toBeGreaterThanOrEqual(1)
	})

	it("defaults the pool policy to round-robin", () => {
		const { registry } = makeRegistry()
		expect(registry.executorPool.getPolicy()).toBe("round-robin")
	})

	it("applies the shofer.workers.loadBalancer setting on init", () => {
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: (key: string, def: unknown) => (key === "shofer.workers.loadBalancer" ? "least-load-5m" : def),
		} as unknown as vscode.WorkspaceConfiguration)
		const { registry } = makeRegistry()
		expect(registry.executorPool.getPolicy()).toBe("least-load-5m")
	})

	it("ignores an invalid setting value (falls back to round-robin)", () => {
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: () => "bogus-policy",
		} as unknown as vscode.WorkspaceConfiguration)
		const { registry } = makeRegistry()
		expect(registry.executorPool.getPolicy()).toBe("round-robin")
	})

	it("setLoadBalancer persists the setting and applies it live to the pool + pushed state", async () => {
		const update = vi.fn(async () => {})
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: (_key: string, def: unknown) => def,
			update,
		} as unknown as vscode.WorkspaceConfiguration)

		const { registry } = makeRegistry()
		expect(registry.getState().loadBalancer).toBe("round-robin")

		let changed = 0
		registry.onChange(() => changed++)
		await registry.handleRequest({ action: "setLoadBalancer", policy: "least-load-5m" })

		// Persisted to the Global config target…
		expect(update).toHaveBeenCalledWith("loadBalancer", "least-load-5m", vscode.ConfigurationTarget.Global)
		// …and applied immediately to the pool + surfaced in the pushed state (no wait
		// for the onDidChangeConfiguration round-trip), with a change fired for the UI.
		expect(registry.executorPool.getPolicy()).toBe("least-load-5m")
		expect(registry.getState().loadBalancer).toBe("least-load-5m")
		expect(changed).toBe(1)
	})

	it("re-reads the policy on a relevant configuration change", () => {
		let changeCb: ((e: vscode.ConfigurationChangeEvent) => void) | undefined
		vi.spyOn(vscode.workspace, "onDidChangeConfiguration").mockImplementation((cb) => {
			changeCb = cb as (e: vscode.ConfigurationChangeEvent) => void
			return { dispose: () => {} }
		})
		let policyValue = "round-robin"
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: (key: string, def: unknown) => (key === "shofer.workers.loadBalancer" ? policyValue : def),
		} as unknown as vscode.WorkspaceConfiguration)

		const { registry } = makeRegistry()
		expect(registry.executorPool.getPolicy()).toBe("round-robin")

		// A change touching an unrelated setting is ignored.
		policyValue = "least-load-1m"
		changeCb?.({ affectsConfiguration: () => false } as vscode.ConfigurationChangeEvent)
		expect(registry.executorPool.getPolicy()).toBe("round-robin")

		// A change touching our setting re-reads it.
		changeCb?.({
			affectsConfiguration: (s: string) => s === "shofer.workers.loadBalancer",
		} as vscode.ConfigurationChangeEvent)
		expect(registry.executorPool.getPolicy()).toBe("least-load-1m")
	})
})

describe("WorkerRegistry — controller→worker config sync (config_sync §4c/§6)", () => {
	const r2Def = { id: "r2", kind: "remote" as const, label: "box2", host: "host:2", tls: false }

	/** Build a registry wired to a drivable {@link SyncedConfigSource}. */
	function withConfigSync(initial?: Partial<GlobalSettings>) {
		const cfg = makeConfigSource(initial)
		const h = makeRegistry(undefined, cfg.source)
		return { ...h, cfg }
	}

	/** Bring a remote def to `connected` with the given (spied) api; returns its FakeConn. */
	async function connectRemote(
		h: ReturnType<typeof makeRegistry>,
		def: { id: string; kind: "remote"; label: string; host: string; tls: boolean },
		api: AgentApi,
		mutate?: (conn: FakeConn) => void,
	): Promise<FakeConn> {
		await h.registry.upsert(def, "tok")
		await h.registry.connect(def.id)
		const conn = h.conns.get(`http://${def.host}`)!
		mutate?.(conn)
		conn.drive("connected", { api })
		return conn
	}

	// 1 ── Push on connect ───────────────────────────────────────────────────────
	it("pushes the current synced slice + version to a remote worker when it reaches connected", async () => {
		const h = withConfigSync()
		const api = makeAgent()
		await connectRemote(h, remoteDef, api)

		// The registry resolved the slice from configSource.getValues() and hashed it (§6).
		expect(api.applyConfig).toHaveBeenCalledTimes(1)
		// The fourth argument is the plugin slice — empty here (no plugin sync source).
		expect(api.applyConfig).toHaveBeenCalledWith(h.cfg.slice(), h.cfg.version(), h.cfg.secrets(), {})
	})

	// 2 ── Broadcast on a synced-key change (and NOT on a frontend-only key) ───────
	it("re-broadcasts applyConfig on a worker-scoped settings change but ignores a frontend-only key", async () => {
		const h = withConfigSync()
		const api = makeAgent()
		await connectRemote(h, remoteDef, api)
		;(api.applyConfig as ReturnType<typeof vi.fn>).mockClear()

		// A worker-scoped key changed → recompute + broadcast the new slice/version.
		h.cfg.setValues({ allowedCommands: ["ls", "pwd"], autoApprovalEnabled: true })
		h.cfg.fire("allowedCommands")
		expect(api.applyConfig).toHaveBeenCalledTimes(1)
		expect(api.applyConfig).toHaveBeenLastCalledWith(h.cfg.slice(), h.cfg.version(), h.cfg.secrets(), {})

		// A frontend-only key is filtered out (SYNCED_KEYS) → no broadcast.
		;(api.applyConfig as ReturnType<typeof vi.fn>).mockClear()
		h.cfg.fire("pinnedApiConfigs")
		expect(api.applyConfig).not.toHaveBeenCalled()
	})

	// A rotated worker-scoped SECRET used to be proven here with the code-index credential.
	// `SYNCED_SECRET_KEYS` is empty now — those credentials belong to the `rag-indexing`
	// plugin and travel on the plugin channel — so the same guarantee is asserted in the
	// plugin-state tests below ("hashes the plugin slice into the config version").

	// 3 ── Never pushes to the Local executor; broadcast count == remote connections ─
	it("broadcasts to every connected remote but never to the Local executor", async () => {
		const h = withConfigSync()
		const api1 = makeAgent()
		const api2 = makeAgent()
		await connectRemote(h, remoteDef, api1)
		await connectRemote(h, r2Def, api2)
		;(api1.applyConfig as ReturnType<typeof vi.fn>).mockClear()
		;(api2.applyConfig as ReturnType<typeof vi.fn>).mockClear()
		;(h.localAgent.applyConfig as ReturnType<typeof vi.fn>).mockClear()

		h.cfg.fire("autoApprovalEnabled")

		// Exactly one push per connected REMOTE worker — the loop iterates `connections`.
		expect(api1.applyConfig).toHaveBeenCalledTimes(1)
		expect(api2.applyConfig).toHaveBeenCalledTimes(1)
		// The Local executor reads controller state in-process — it is never pushed config.
		expect(h.localAgent.applyConfig).not.toHaveBeenCalled()
	})

	// 4 ── Version-gate: a stale remote is not assignable until it converges ───────
	it("keeps a connected-but-stale remote out of the assignable set until its configVersion matches", async () => {
		const h = withConfigSync()
		const api = makeAgent()
		// The push fails, so the worker never advances its applied version → stays stale.
		;(api.applyConfig as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("push failed"))
		const conn = await connectRemote(h, remoteDef, api)
		await Promise.resolve() // let the (rejected) push settle

		// Connected + in the pool, but version-gated out of new-task assignment.
		expect(h.registry.executorPool.has("r1")).toBe(true)
		expect(conn.configVersion).toBeUndefined()
		expect(h.registry.executorPool.assignableIds()).not.toContain("r1")
		expect(h.registry.hasEnabledRemote()).toBe(false)

		// It applies the desired config (echoes the version) → becomes assignable.
		conn.markConfigApplied(h.cfg.version())
		expect(h.registry.executorPool.assignableIds()).toContain("r1")
		expect(h.registry.hasEnabledRemote()).toBe(true)
	})

	// 5 ── Unmanaged remote is exempt from gating even with no applied version ─────
	it("treats an unmanaged remote (managed:false) as assignable though it never applies config", async () => {
		const h = withConfigSync()
		const api = makeAgent()
		;(api.applyConfig as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("push failed"))
		// A self-administered worker reports managed:false → exempt from config-version gating.
		const conn = await connectRemote(h, remoteDef, api, (c) => {
			c.managed = false
		})
		await Promise.resolve()

		expect(conn.configVersion).toBeUndefined()
		expect(h.registry.executorPool.assignableIds()).toContain("r1")
		expect(h.registry.hasEnabledRemote()).toBe(true)
	})

	// 6 ── Inert without a configSource (unit-test / no-ContextProxy path) ─────────
	it("is inert when no configSource is provided: no applyConfig push, worker not gated", async () => {
		const h = makeRegistry() // no configSource
		const api = makeAgent()
		await connectRemote(h, remoteDef, api)

		expect(api.applyConfig).not.toHaveBeenCalled()
		// desiredConfigVersion stays undefined → the pool never gates on config.
		expect(h.registry.executorPool.assignableIds()).toContain("r1")
	})

	// 7 ── The plugin half of the slice ───────────────────────────────────────────
	describe("plugin state (plugins that declare syncConfig)", () => {
		const INDEXER: SyncedPluginState = {
			"rag-indexing": {
				config: { embedderProvider: "openai", searchOnly: true },
				secrets: { embedderApiKey: "sk-controller" },
			},
		}

		function withPluginSync(initial: SyncedPluginState = INDEXER) {
			const cfg = makeConfigSource()
			const plugins = makePluginSyncSource(initial)
			const h = makeRegistry(undefined, cfg.source, plugins.source)
			return { ...h, cfg, plugins }
		}

		it("pushes the plugin slice alongside the settings slice", async () => {
			const h = withPluginSync()
			await Promise.resolve() // the slice is built asynchronously at wiring time
			const api = makeAgent()
			await connectRemote(h, remoteDef, api)

			expect(api.applyConfig).toHaveBeenCalledWith(h.cfg.slice(), expect.any(String), h.cfg.secrets(), INDEXER)
		})

		it("hashes the plugin slice into the config version, so a plugin-only change converges", async () => {
			const h = withPluginSync()
			await Promise.resolve()
			const api = makeAgent()
			await connectRemote(h, remoteDef, api)
			const before = (api.applyConfig as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]
			;(api.applyConfig as ReturnType<typeof vi.fn>).mockClear()

			// Nothing in the SETTINGS slice moved — only the plugin's own config did. Without
			// the plugin slice in the hash the version would be unchanged and the worker would
			// sit on a stale embedder forever.
			const rotated: SyncedPluginState = {
				"rag-indexing": {
					config: { embedderProvider: "gemini", searchOnly: true },
					secrets: { embedderApiKey: "sk-rotated" },
				},
			}
			h.plugins.set(rotated)
			h.plugins.fire()
			await Promise.resolve()
			await Promise.resolve()

			expect(api.applyConfig).toHaveBeenCalledTimes(1)
			const [, after, , pluginSlice] = (api.applyConfig as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(pluginSlice).toEqual(rotated)
			expect(after).not.toBe(before)
			expect(after).toBe(h.cfg.version(rotated))
		})

		it("does not re-broadcast when the rebuilt plugin slice is identical", async () => {
			const h = withPluginSync()
			await Promise.resolve()
			const api = makeAgent()
			await connectRemote(h, remoteDef, api)
			;(api.applyConfig as ReturnType<typeof vi.fn>).mockClear()

			// A plugin reload or an unrelated save fires the change; the slice is unchanged,
			// so every worker would otherwise re-apply an identical payload.
			h.plugins.fire()
			await Promise.resolve()
			await Promise.resolve()

			expect(api.applyConfig).not.toHaveBeenCalled()
		})

		it("sends an empty plugin slice when no plugin opts in", async () => {
			const h = withPluginSync({})
			await Promise.resolve()
			const api = makeAgent()
			await connectRemote(h, remoteDef, api)

			expect(api.applyConfig).toHaveBeenCalledWith(h.cfg.slice(), h.cfg.version(), h.cfg.secrets(), {})
		})
	})
})
