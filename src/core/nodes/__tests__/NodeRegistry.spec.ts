import { describe, it, expect, beforeEach, vi } from "vitest"
import type * as vscode from "vscode"

import type { AgentApi, ServerEvent, ShoferAPI, ShoferNodeConnState } from "@shofer/types"
import { LOCAL_NODE_ID, ShoferEventName } from "@shofer/types"

import { NodeRegistry, type INodeConnection, type NodeConnectionFactory } from "../NodeRegistry.js"

/**
 * Controller-side registry (Shofer Nodes L1). Driven with an in-memory
 * ExtensionContext stub (globalState + secrets) and a fake NodeConnection, so
 * persistence, pool population, and the pushed view model are all deterministic.
 */

function makeAgent(): AgentApi {
	return {
		createTask: vi.fn(async () => ({ taskId: "t" })),
		sendMessage: vi.fn(async () => {}),
		cancelTask: vi.fn(async () => {}),
		respondToAsk: vi.fn(async () => {}),
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

/** A drivable fake connection satisfying INodeConnection. */
class FakeConn implements INodeConnection {
	status: ShoferNodeConnState = "disconnected"
	latencyMs?: number
	agentVersion?: string
	error?: string
	api: AgentApi | undefined
	disposed = false
	private cbs = new Set<(s: ShoferNodeConnState) => void>()

	constructor(readonly opts: { baseUrl: string; token?: string; controllerVersion: string }) {}

	onStatusChange(cb: (s: ShoferNodeConnState) => void): () => void {
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
		status: ShoferNodeConnState,
		extra: Partial<Pick<FakeConn, "api" | "latencyMs" | "agentVersion" | "error">> = {},
	): void {
		Object.assign(this, extra)
		this.set(status)
	}
	private set(s: ShoferNodeConnState): void {
		this.status = s
		for (const cb of [...this.cbs]) cb(s)
	}
}

function makeRegistry(seedDefs?: unknown[]) {
	const { context, globals, secrets } = makeContext()
	if (seedDefs) globals.set("shoferNodes.defs", seedDefs)
	const conns = new Map<string, FakeConn>()
	const createConnection: NodeConnectionFactory = (o) => {
		const c = new FakeConn(o)
		conns.set(o.baseUrl, c)
		return c
	}
	const localAgent = makeAgent()
	const registry = new NodeRegistry(
		{ context, localApi: {} as ShoferAPI, controllerVersion: "1.0.0" },
		{ createConnection, localAgent },
	)
	return { registry, globals, secrets, conns, localAgent }
}

/** A fake {@link NodeProviderHost} recording the in-process Local new-task path. */
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

describe("NodeRegistry (Shofer Nodes L1)", () => {
	let h: ReturnType<typeof makeRegistry>

	beforeEach(() => {
		h = makeRegistry()
	})

	it("registers Local at construction and reports it running", () => {
		const state = h.registry.getState()
		expect(state.activeNodeId).toBe(LOCAL_NODE_ID)
		expect(state.nodes).toHaveLength(1)
		expect(state.nodes[0]).toMatchObject({
			id: LOCAL_NODE_ID,
			kind: "local",
			status: "running",
			isActive: true,
			disabled: false,
			agentVersion: "1.0.0",
		})
		expect(h.registry.executorPool.has(LOCAL_NODE_ID)).toBe(true)
	})

	it("upsert persists a remote def + token, surfaces hasToken (no secret leak)", async () => {
		let changed = 0
		h.registry.onChange(() => changed++)
		await h.registry.upsert(remoteDef, "s3cret")

		expect(changed).toBe(1)
		expect(h.secrets.get("shoferNode.token.r1")).toBe("s3cret")
		expect(h.globals.get("shoferNodes.defs")).toContainEqual(expect.objectContaining({ id: "r1", kind: "remote" }))

		const view = h.registry.getState().nodes.find((n) => n.id === "r1")!
		expect(view).toMatchObject({ id: "r1", status: "disconnected", hasToken: true, disabled: false })
		expect(view).not.toHaveProperty("token")
	})

	it("connect() sets autoConnect, and a connected node joins the pool", async () => {
		await h.registry.upsert(remoteDef)
		await h.registry.connect("r1")

		// Still connecting → not yet pooled.
		expect(h.registry.executorPool.has("r1")).toBe(false)
		expect(h.registry.getState().nodes.find((n) => n.id === "r1")!.status).toBe("connecting")

		// Drive to connected with a live api → the registry adds it to the pool.
		const api = makeAgent()
		h.conns.get("http://host:1")!.drive("connected", { api, latencyMs: 12, agentVersion: "1.0.0" })

		expect(h.registry.executorPool.has("r1")).toBe(true)
		const view = h.registry.getState().nodes.find((n) => n.id === "r1")!
		expect(view).toMatchObject({ status: "connected", latencyMs: 12, agentVersion: "1.0.0" })
		const savedR1 = (h.globals.get("shoferNodes.defs") as any[]).find((d) => d.id === "r1")
		expect(savedR1).toMatchObject({ id: "r1", autoConnect: true })
	})

	it("a connected node dropping to reconnecting leaves the pool", async () => {
		await h.registry.upsert(remoteDef)
		await h.registry.connect("r1")
		const conn = h.conns.get("http://host:1")!
		conn.drive("connected", { api: makeAgent() })
		expect(h.registry.executorPool.has("r1")).toBe(true)

		conn.drive("reconnecting", { api: undefined, error: "timeout" })
		expect(h.registry.executorPool.has("r1")).toBe(false)
		expect(h.registry.getState().nodes.find((n) => n.id === "r1")!.status).toBe("reconnecting")
	})

	it("disconnect() clears autoConnect, tears down, and removes from the pool", async () => {
		await h.registry.upsert(remoteDef)
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: makeAgent() })

		await h.registry.disconnect("r1")
		expect(h.registry.executorPool.has("r1")).toBe(false)
		const saved = (h.globals.get("shoferNodes.defs") as any[]).find((d) => d.id === "r1")
		expect(saved).toMatchObject({ id: "r1", autoConnect: false })
		expect(h.registry.getState().nodes.find((n) => n.id === "r1")!.status).toBe("disconnected")
	})

	it("setDisabled(remote) disconnects a connected node; setDisabled(local) toggles pool", async () => {
		await h.registry.upsert(remoteDef)
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: makeAgent() })

		await h.registry.setDisabled("r1", true)
		expect(h.registry.executorPool.has("r1")).toBe(false)
		expect(h.registry.getState().nodes.find((n) => n.id === "r1")!.disabled).toBe(true)

		// Local can be disabled too.
		await h.registry.setDisabled(LOCAL_NODE_ID, true)
		const local = h.registry.getState().nodes.find((n) => n.id === LOCAL_NODE_ID)!
		expect(local).toMatchObject({ status: "disconnected", disabled: true })
	})

	it("refuses to remove Local, removes a remote (def + token gone)", async () => {
		await h.registry.upsert(remoteDef, "tok")
		await h.registry.remove(LOCAL_NODE_ID)
		expect(h.registry.getState().nodes.some((n) => n.id === LOCAL_NODE_ID)).toBe(true)

		await h.registry.remove("r1")
		expect(h.registry.getState().nodes.some((n) => n.id === "r1")).toBe(false)
		expect(h.secrets.get("shoferNode.token.r1")).toBeUndefined()
		expect(h.globals.get("shoferNodes.defs")).toEqual([expect.objectContaining({ id: LOCAL_NODE_ID })])
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
		// Ownership is still recorded as Local so activeNodeId() reports Local.
		expect(taskId).toBe("local-task-1")
		expect(h.registry.executorPool.ownerOf("local-task-1")).toBe(LOCAL_NODE_ID)
	})

	it("hasEnabledRemote reflects assignable remotes; a preferredNodeId=local routes in-process", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)
		expect(h.registry.hasEnabledRemote()).toBe(false)

		// Connect a remote → hasEnabledRemote true.
		await h.registry.upsert(remoteDef, "tok")
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: makeAgent() })
		expect(h.registry.hasEnabledRemote()).toBe(true)

		// preferredNodeId=local pins the task to the in-process path even with a remote present.
		await h.registry.routeNewTask({ prompt: "pin-local", preferredNodeId: LOCAL_NODE_ID })
		expect(host.createManagedTask).toHaveBeenCalledTimes(1)
		expect(h.localAgent.createTask).not.toHaveBeenCalled()
	})

	it("routeNewTask on a remote owner dispatches through the pool (never the in-process path)", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)
		const remoteApi = makeAgent()
		;(remoteApi.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({ taskId: "r1-task-1" })

		await h.registry.upsert(remoteDef, "tok")
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: remoteApi })

		// Force the remote owner via preferredNodeId (deterministic, no RR dependence).
		const taskId = await h.registry.routeNewTask({ prompt: "remote-run", preferredNodeId: "r1" })
		expect(remoteApi.createTask).toHaveBeenCalledWith({ prompt: "remote-run" })
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
		const taskId = await h.registry.routeNewTask({ prompt: "go", preferredNodeId: "r1" })
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
		const shadow = h.registry.getFocusedShadow()!
		expect(shadow.messages).toEqual([msg(1, { text: "m1!" })])
	})

	it("routes respondToAsk for a shadow task to the owning executor (reverse ask channel)", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)
		const remote = makeDrivableAgent("r1-task-1")
		await h.registry.upsert(remoteDef, "tok")
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: remote.api })

		const taskId = await h.registry.routeNewTask({ prompt: "go", preferredNodeId: "r1" })
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

	it("carries remote token usage onto the shadow's header summary (full-fidelity meter)", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)
		const remote = makeDrivableAgent("r1-task-1")
		await h.registry.upsert(remoteDef, "tok")
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: remote.api })
		const taskId = await h.registry.routeNewTask({ prompt: "go", preferredNodeId: "r1" })

		// Before any usage event, the summary is zeroed.
		expect(h.registry.getFocusedShadow()!.toTaskItem()).toMatchObject({ tokensIn: 0, tokensOut: 0, totalCost: 0 })

		remote.emit({
			type: ShoferEventName.TaskTokenUsageUpdated,
			args: [
				taskId,
				{ totalTokensIn: 1200, totalTokensOut: 340, totalCost: 0.05, contextTokens: 1540 },
				{},
			],
		})

		expect(h.registry.getFocusedShadow()!.toTaskItem()).toMatchObject({
			tokensIn: 1200,
			tokensOut: 340,
			totalCost: 0.05,
		})
	})

	it("drops Local-tagged pool events (no shadow, no webview render posts)", async () => {
		// A registry whose LOCAL agent is drivable, so we can emit a Local-tagged event.
		const { context } = makeContext()
		const localDrivable = makeDrivableAgent("local-1")
		const registry = new NodeRegistry(
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
		expect(registry.getFocusedShadow()).toBeUndefined()
	})

	it("buffers a non-auto-approved remote ask + mirrors it to the webview (interactive approval)", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)
		const remote = makeDrivableAgent("r1-task-1")
		await h.registry.upsert(remoteDef, "tok")
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: remote.api })
		const taskId = await h.registry.routeNewTask({ prompt: "go", preferredNodeId: "r1" })
		host.postMessageToWebview.mockClear()

		const askMessage = msg(2, { type: "ask", ask: "command", autoApproved: false })
		remote.emit({ type: ShoferEventName.Message, args: [{ taskId, action: "created", message: askMessage }] })

		// The ask is buffered like any other message (no "blocked" dead-end) and
		// mirrored to the webview so it can render normal approve/deny buttons.
		const shadow = h.registry.getFocusedShadow()!
		expect(shadow.messages).toContainEqual(askMessage)
		expect(host.postMessageToWebview).toHaveBeenCalledWith({
			type: "shoferMessageAppended",
			shoferMessage: askMessage,
		})
	})

	// ── L2: dynamic activeNodeId + focus swaps ───────────────────────────────────

	it("activeNodeId + isActive follow the focused task owner across a focus swap", async () => {
		const host = makeProviderHost()
		h.registry.attachProvider(host)
		const remote = makeDrivableAgent("r1-task-1")
		await h.registry.upsert(remoteDef, "tok")
		await h.registry.connect("r1")
		h.conns.get("http://host:1")!.drive("connected", { api: remote.api })

		// Before any remote task: Local is active.
		expect(h.registry.getState().activeNodeId).toBe(LOCAL_NODE_ID)

		// Focus a remote shadow → the remote node becomes active + isActive.
		await h.registry.routeNewTask({ prompt: "go", preferredNodeId: "r1" })
		let state = h.registry.getState()
		expect(state.activeNodeId).toBe("r1")
		expect(state.nodes.find((n) => n.id === "r1")!.isActive).toBe(true)
		expect(state.nodes.find((n) => n.id === LOCAL_NODE_ID)!.isActive).toBe(false)

		// Swap focus back to a local task → Local active again.
		h.registry.clearShadowFocus()
		state = h.registry.getState()
		expect(state.activeNodeId).toBe(LOCAL_NODE_ID)
		expect(state.nodes.find((n) => n.id === "r1")!.isActive).toBe(false)
	})

	// ── L2/D: shared singleton + multi-provider ──────────────────────────────────

	it("getInstance returns the same shared registry; both attached providers get shoferNodes", async () => {
		NodeRegistry.resetInstance()
		const { context } = makeContext()
		const opts = { context, localApi: {} as ShoferAPI, controllerVersion: "1.0.0" }
		const a = NodeRegistry.getInstance(opts, { localAgent: makeAgent() })!
		const b = NodeRegistry.getInstance()! // no args → same instance
		expect(a).toBe(b)

		const sidebar = makeProviderHost()
		const tab = makeProviderHost()
		let sidebarPushes = 0
		let tabPushes = 0
		a.onChange(() => sidebarPushes++)
		a.onChange(() => tabPushes++)
		a.attachProvider(sidebar)
		a.attachProvider(tab)

		// A change fires ALL onChange listeners (both webviews get node state).
		await a.setDisabled(LOCAL_NODE_ID, true)
		expect(sidebarPushes).toBeGreaterThan(0)
		expect(tabPushes).toBeGreaterThan(0)
		NodeRegistry.resetInstance()
	})

	it("routeNewTask(initiator) retargets the render provider (task renders where it started)", async () => {
		NodeRegistry.resetInstance()
		const { context } = makeContext()
		const registry = NodeRegistry.getInstance(
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
		NodeRegistry.resetInstance()
	})

	it("init() auto-connects persisted autoConnect remotes and hydrates hasToken", async () => {
		const seeded = makeRegistry([{ id: "r1", kind: "remote", label: "box", host: "host:1", autoConnect: true }])
		seeded.secrets.set("shoferNode.token.r1", "tok")

		await seeded.registry.init()
		// A connection was created for the autoConnect remote.
		const conn = seeded.conns.get("http://host:1")
		expect(conn).toBeDefined()
		conn!.drive("connected", { api: makeAgent() })

		expect(seeded.registry.executorPool.has("r1")).toBe(true)
		const view = seeded.registry.getState().nodes.find((n) => n.id === "r1")!
		expect(view).toMatchObject({ status: "connected", hasToken: true })
	})
})
