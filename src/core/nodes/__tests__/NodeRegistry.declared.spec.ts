import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs/promises"
import os from "os"
import * as path from "path"
import * as vscode from "vscode"

import type { AgentApi, LoadSample, ShoferAPI, ShoferNodeConnState, ShoferNodeDef } from "@shofer/types"
import { TypedEmitter } from "@shofer/types"

import { NodeRegistry, type INodeConnection, type NodeConnectionFactory } from "../NodeRegistry.js"

/**
 * Declared nodes — `.shofer/nodes.json` reconciled into the registry
 * (docs/workspace_agent_pool.md §4). This is the mechanism a platform-provisioned pool
 * arrives through, so the tests drive the real loader against real files and assert the
 * four rules that matter operationally: a corrupt file changes nothing, a withdrawn
 * entry disconnects, a user's runtime flags survive a reconcile, and the token is read
 * from the file the declaration names rather than from SecretStorage.
 */

function makeAgent(): AgentApi {
	return {
		createTask: vi.fn(async () => ({ taskId: "t" })),
		sendMessage: vi.fn(async () => {}),
		cancelTask: vi.fn(async () => {}),
		respondToAsk: vi.fn(async () => {}),
		applyConfig: vi.fn(async () => {}),
		pluginRequest: vi.fn(async () => null),
		subscribe: vi.fn(() => () => {}),
	} as unknown as AgentApi
}

function makeContext() {
	const globals = new Map<string, unknown>()
	const secrets = new Map<string, string>()
	return {
		context: {
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
		} as unknown as vscode.ExtensionContext,
		globals,
		secrets,
	}
}

class FakeConn implements INodeConnection {
	status: ShoferNodeConnState = "disconnected"
	latencyMs?: number
	agentVersion?: string
	error?: string
	load: LoadSample | undefined
	configVersion: string | undefined
	managed = true
	api: AgentApi | undefined
	disposed = false
	private cbs = new Set<(s: ShoferNodeConnState) => void>()

	constructor(readonly opts: { baseUrl: string; token?: string; controllerVersion: string }) {}

	markConfigApplied(version: string): void {
		this.configVersion = version
	}
	onStatusChange(cb: (s: ShoferNodeConnState) => void): () => void {
		this.cbs.add(cb)
		return () => this.cbs.delete(cb)
	}
	async connect(): Promise<void> {
		this.status = "connecting"
	}
	disconnect(): void {
		this.status = "disconnected"
	}
	dispose(): void {
		this.disposed = true
		this.disconnect()
	}
}

describe("NodeRegistry — declared nodes (.shofer/nodes.json)", () => {
	let tmp: string
	let globalDir: string
	let userDir: string
	const registries: NodeRegistry[] = []

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "shofer-nodesdecl-"))
		globalDir = path.join(tmp, "global", ".shofer")
		userDir = path.join(tmp, "user", ".shofer")
		await fs.mkdir(globalDir, { recursive: true })
		await fs.mkdir(userDir, { recursive: true })
	})

	afterEach(async () => {
		for (const registry of registries.splice(0)) registry.dispose()
		await fs.rm(tmp, { recursive: true, force: true })
	})

	async function writeNodes(scopeDir: string, nodes: Record<string, unknown>): Promise<void> {
		await fs.writeFile(path.join(scopeDir, "nodes.json"), JSON.stringify({ version: 1, nodes }))
	}

	function makeRegistry(seedDefs?: ShoferNodeDef[]) {
		const { context, globals, secrets } = makeContext()
		if (seedDefs) globals.set("shoferNodes.defs", seedDefs)
		const conns: FakeConn[] = []
		const createConnection: NodeConnectionFactory = (o) => {
			const c = new FakeConn(o)
			conns.push(c)
			return c
		}
		const scopeFiles = new TypedEmitter<{ files: string[] }>()
		const registry = new NodeRegistry(
			{
				context,
				localApi: {} as ShoferAPI,
				controllerVersion: "1.0.0",
				scopeSource: {
					getScopeRoots: () => ({ global: globalDir, user: userDir }),
					onDidChangeScopeFiles: scopeFiles.event,
				},
			},
			{ createConnection, localAgent: makeAgent() },
		)
		registries.push(registry)
		/** Fire the watcher signal and let the async reconcile settle. */
		const touch = async (files = ["nodes.json"]) => {
			scopeFiles.fire({ files })
			await new Promise((resolve) => setTimeout(resolve, 20))
		}
		return { registry, globals, secrets, conns, touch }
	}

	const defOf = (registry: NodeRegistry, id: string) => registry.list().find((n) => n.id === id)

	it("registers a node declared in the global scope, and connects it", async () => {
		await writeNodes(globalDir, { "pool-0": { label: "runner-0", host: "runner-0.ws.svc:30099" } })
		const { registry, conns } = makeRegistry()

		await registry.init()

		const node = defOf(registry, "pool-0")
		expect(node).toMatchObject({ kind: "remote", label: "runner-0", declared: true })
		// autoConnect defaults to true: a declared node exists to be used.
		expect(conns[0]?.opts.baseUrl).toBe("http://runner-0.ws.svc:30099")
	})

	it("adds a node when the file changes while running — no restart", async () => {
		const { registry, conns, touch } = makeRegistry()
		await registry.init()
		expect(defOf(registry, "pool-1")).toBeUndefined()

		await writeNodes(globalDir, { "pool-1": { host: "runner-1.ws.svc:30099" } })
		await touch()

		expect(defOf(registry, "pool-1")).toBeDefined()
		expect(conns.some((c) => c.opts.baseUrl === "http://runner-1.ws.svc:30099")).toBe(true)
	})

	it("withdraws a node the declaration no longer names, disconnecting it", async () => {
		await writeNodes(globalDir, { "pool-0": { host: "runner-0.ws.svc:30099" } })
		const { registry, conns, touch } = makeRegistry()
		await registry.init()

		await writeNodes(globalDir, {})
		await touch()

		expect(defOf(registry, "pool-0")).toBeUndefined()
		expect(conns[0].disposed).toBe(true)
	})

	it("keeps the last good set when the file is corrupted", async () => {
		await writeNodes(globalDir, { "pool-0": { host: "runner-0.ws.svc:30099" } })
		const { registry, touch } = makeRegistry()
		await registry.init()

		// A typo must not empty the pool — the deliberate deviation from "corrupt ⇒ empty".
		await fs.writeFile(path.join(globalDir, "nodes.json"), "{ nodes: oops")
		await touch()

		expect(defOf(registry, "pool-0")).toBeDefined()
	})

	it("re-points a node whose host changed, tearing the old connection down", async () => {
		await writeNodes(globalDir, { "pool-0": { host: "old.ws.svc:30099" } })
		const { registry, conns, touch } = makeRegistry()
		await registry.init()
		const first = conns[0]

		await writeNodes(globalDir, { "pool-0": { host: "new.ws.svc:30099" } })
		await touch()

		expect(first.disposed).toBe(true)
		expect(conns.some((c) => c.opts.baseUrl === "http://new.ws.svc:30099")).toBe(true)
	})

	it("preserves a disable the user made, across reconciles", async () => {
		await writeNodes(globalDir, { "pool-0": { host: "runner-0.ws.svc:30099" } })
		const { registry, touch } = makeRegistry()
		await registry.init()

		await registry.setDisabled("pool-0", true)
		// An unrelated rewrite of the same file must not silently re-enable the node.
		await writeNodes(globalDir, { "pool-0": { host: "runner-0.ws.svc:30099", label: "renamed" } })
		await touch()

		expect(defOf(registry, "pool-0")).toMatchObject({ label: "renamed", disabled: true })
	})

	it("lets the declaration state `disabled` explicitly and win", async () => {
		await writeNodes(globalDir, { "pool-0": { host: "runner-0.ws.svc:30099" } })
		const { registry, touch } = makeRegistry()
		await registry.init()

		await writeNodes(globalDir, { "pool-0": { host: "runner-0.ws.svc:30099", disabled: true } })
		await touch()

		expect(defOf(registry, "pool-0")?.disabled).toBe(true)
	})

	it("refuses to delete a declared node from the UI", async () => {
		await writeNodes(globalDir, { "pool-0": { host: "runner-0.ws.svc:30099" } })
		const { registry } = makeRegistry()
		await registry.init()

		await registry.remove("pool-0")

		expect(defOf(registry, "pool-0")).toBeDefined()
	})

	it("reads the bearer token from the file the declaration names", async () => {
		const tokenFile = path.join(tmp, "node-token")
		await fs.writeFile(tokenFile, "  s3cret\n")
		await writeNodes(globalDir, { "pool-0": { host: "runner-0.ws.svc:30099", tokenFile } })
		const { registry, conns } = makeRegistry()

		await registry.init()

		expect(conns[0].opts.token).toBe("s3cret")
	})

	it("still connects when the token file is missing, so the failure is the node's to report", async () => {
		await writeNodes(globalDir, {
			"pool-0": { host: "runner-0.ws.svc:30099", tokenFile: path.join(tmp, "absent") },
		})
		const { registry, conns } = makeRegistry()

		await registry.init()

		expect(conns[0].opts.token).toBeUndefined()
	})

	it("leaves a hand-added node alone", async () => {
		const { registry, touch } = makeRegistry([
			{ id: "mine", kind: "remote", label: "My box", host: "192.168.1.5:30099" },
		])
		await registry.init()

		await writeNodes(globalDir, { "pool-0": { host: "runner-0.ws.svc:30099" } })
		await touch()

		expect(defOf(registry, "mine")).toBeDefined()
		expect(defOf(registry, "pool-0")).toBeDefined()
	})

	it("ignores an attempt to declare the reserved Local id", async () => {
		await writeNodes(globalDir, { local: { host: "somewhere:30099" } })
		const { registry } = makeRegistry()

		await registry.init()

		expect(defOf(registry, "local")).toMatchObject({ kind: "local" })
	})

	it("honours a `locked.json` lock on a node id", async () => {
		await writeNodes(globalDir, { "pool-0": { host: "platform.ws.svc:30099" } })
		await writeNodes(userDir, { "pool-0": { host: "user-hijack:30099" } })
		await fs.writeFile(
			path.join(globalDir, "locked.json"),
			JSON.stringify({ version: 1, locked: ["nodes/pool-0"] }),
		)
		const { registry, conns } = makeRegistry()

		await registry.init()

		expect(conns[0].opts.baseUrl).toBe("http://platform.ws.svc:30099")
	})
})
