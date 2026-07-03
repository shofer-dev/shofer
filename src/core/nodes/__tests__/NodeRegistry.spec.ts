import { describe, it, expect, beforeEach, vi } from "vitest"
import type * as vscode from "vscode"

import type { AgentApi, ShoferAPI, ShoferNodeConnState } from "@shofer/types"
import { LOCAL_NODE_ID } from "@shofer/types"

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
	drive(status: ShoferNodeConnState, extra: Partial<Pick<FakeConn, "api" | "latencyMs" | "agentVersion" | "error">> = {}): void {
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
		postMessageToWebview: vi.fn(async () => {}),
	}
	return host
}

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
