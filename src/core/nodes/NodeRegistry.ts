import * as vscode from "vscode"

import {
	type AgentApi,
	type ShoferAPI,
	type ShoferNodeConnState,
	type ShoferNodeDef,
	type ShoferNodeRequest,
	type ShoferNodeView,
	type ShoferNodesState,
	ExecutorPool,
	LOCAL_NODE_ID,
} from "@shofer/types"
import { NodeConnection, ShoferApiAgent } from "@shofer/core"

/**
 * Controller-side orchestrator for Shofer Nodes (v3-native, L1).
 *
 * Owns the {@link ExecutorPool} and the lifecycle of every node: the built-in
 * **Local** in-process agent plus zero or more **remote** executors (`shofer
 * serve` on another host, driven over HTTP/SSE via {@link NodeConnection}). It
 * persists the non-secret {@link ShoferNodeDef}s in `globalState` and the
 * per-node bearer tokens in `secrets`, keeps the pool populated as remotes come
 * and go, and projects everything into the {@link ShoferNodesState} the webview
 * renders (never leaking a token — only its presence via `hasToken`).
 *
 * L1 scope: registry + connection status + pool population + UI state. Task
 * creation is NOT routed through the pool yet (Level 2), so `activeNodeId`
 * defaults to Local.
 */

/** The minimal connection surface the registry drives (satisfied by {@link NodeConnection}). */
export interface INodeConnection {
	readonly status: ShoferNodeConnState
	readonly latencyMs?: number
	readonly agentVersion?: string
	readonly error?: string
	readonly api: AgentApi | undefined
	onStatusChange(cb: (state: ShoferNodeConnState) => void): () => void
	connect(): Promise<void>
	disconnect(): void
	dispose(): void
}

/** Factory for a node connection (injectable so the registry is unit-testable). */
export type NodeConnectionFactory = (opts: {
	baseUrl: string
	token?: string
	controllerVersion: string
}) => INodeConnection

export interface NodeRegistryOptions {
	context: vscode.ExtensionContext
	localApi: ShoferAPI
	controllerVersion: string
}

export interface NodeRegistryDeps {
	/** Override the connection factory (tests inject a fake). */
	createConnection?: NodeConnectionFactory
	/** Override the Local agent adapter (tests avoid needing a real ShoferAPI). */
	localAgent?: AgentApi
}

const DEFS_KEY = "shoferNodes.defs"
const tokenKey = (id: string): string => `shoferNode.token.${id}`

export class NodeRegistry {
	private readonly context: vscode.ExtensionContext
	private readonly controllerVersion: string
	private readonly pool = new ExecutorPool()
	private readonly localAgent: AgentApi
	private readonly createConnection: NodeConnectionFactory
	private readonly connections = new Map<string, INodeConnection>()
	private readonly hasTokenCache = new Set<string>()
	private readonly listeners = new Set<() => void>()
	private defs: ShoferNodeDef[] = []

	constructor(opts: NodeRegistryOptions, deps: NodeRegistryDeps = {}) {
		this.context = opts.context
		this.controllerVersion = opts.controllerVersion
		this.localAgent = deps.localAgent ?? new ShoferApiAgent(opts.localApi)
		this.createConnection = deps.createConnection ?? ((o) => new NodeConnection(o))

		// Load persisted defs and guarantee a Local entry (first).
		this.defs = this.loadDefs()
		if (!this.defs.some((d) => d.id === LOCAL_NODE_ID)) {
			this.defs.unshift({ id: LOCAL_NODE_ID, kind: "local", label: "Local" })
		}

		// Register Local at construction; reflect its persisted disabled flag.
		this.pool.add({ id: LOCAL_NODE_ID, api: this.localAgent })
		if (this.getDef(LOCAL_NODE_ID)?.disabled) this.pool.setDisabled(LOCAL_NODE_ID, true)
	}

	/**
	 * Async second phase: hydrate token presence and auto-connect every remote
	 * flagged `autoConnect && !disabled`. The extension calls this after wiring
	 * `onChange`. Safe to call once.
	 */
	async init(): Promise<void> {
		for (const def of this.defs) {
			if (def.kind !== "remote") continue
			if (await this.context.secrets.get(tokenKey(def.id))) this.hasTokenCache.add(def.id)
			if (def.autoConnect && !def.disabled) await this.startConnection(def)
		}
		this.fireChange()
	}

	/** Subscribe to any registry/connection status change. Returns an unsubscribe. */
	onChange(cb: () => void): () => void {
		this.listeners.add(cb)
		return () => this.listeners.delete(cb)
	}

	/** Dispatch a webview {@link ShoferNodeRequest}. */
	async handleRequest(req: ShoferNodeRequest): Promise<void> {
		switch (req.action) {
			case "list":
				this.fireChange()
				return
			case "upsert":
				return this.upsert(req.node, req.token)
			case "remove":
				return this.remove(req.id)
			case "connect":
				return this.connect(req.id)
			case "disconnect":
				return this.disconnect(req.id)
			case "setDisabled":
				return this.setDisabled(req.id, req.disabled)
		}
	}

	// ── request handlers ───────────────────────────────────────────────────────

	list(): ShoferNodeView[] {
		return this.buildNodeViews()
	}

	async upsert(node: ShoferNodeDef, token?: string): Promise<void> {
		const existing = this.getDef(node.id)
		// Preserve runtime flags (autoConnect/disabled) the UI form doesn't carry.
		const merged: ShoferNodeDef = { ...existing, ...node, kind: "remote" }
		this.setDef(merged)
		if (token !== undefined) {
			await this.context.secrets.store(tokenKey(node.id), token)
			this.hasTokenCache.add(node.id)
		}
		await this.persist()
		this.fireChange()
	}

	async remove(id: string): Promise<void> {
		if (id === LOCAL_NODE_ID) return // Local is non-removable.
		this.teardownConnection(id)
		this.defs = this.defs.filter((d) => d.id !== id)
		await this.context.secrets.delete(tokenKey(id))
		this.hasTokenCache.delete(id)
		await this.persist()
		this.fireChange()
	}

	async connect(id: string): Promise<void> {
		const def = this.getDef(id)
		if (!def || def.kind !== "remote") return
		def.autoConnect = true
		await this.persist()
		await this.startConnection(def)
		this.fireChange()
	}

	async disconnect(id: string): Promise<void> {
		const def = this.getDef(id)
		if (def) {
			def.autoConnect = false
			await this.persist()
		}
		this.teardownConnection(id)
		this.fireChange()
	}

	async setDisabled(id: string, disabled: boolean): Promise<void> {
		const def = this.getDef(id)
		if (!def) return
		def.disabled = disabled
		await this.persist()
		// Disabling a connected remote also disconnects it (drops it from the pool).
		if (id !== LOCAL_NODE_ID && disabled) this.teardownConnection(id)
		this.pool.setDisabled(id, disabled)
		this.fireChange()
	}

	// ── view model ─────────────────────────────────────────────────────────────

	buildNodeViews(): ShoferNodeView[] {
		const activeNodeId = this.activeNodeId()
		return this.defs.map((def) => {
			const disabled = def.disabled ?? false
			if (def.kind === "local") {
				return {
					...def,
					status: disabled ? "disconnected" : "running",
					isActive: activeNodeId === LOCAL_NODE_ID,
					disabled,
					agentVersion: this.controllerVersion,
				}
			}
			const conn = this.connections.get(def.id)
			return {
				...def,
				status: conn?.status ?? "disconnected",
				latencyMs: conn?.latencyMs,
				agentVersion: conn?.agentVersion,
				error: conn?.error,
				isActive: activeNodeId === def.id,
				disabled,
				hasToken: this.hasTokenCache.has(def.id),
			}
		})
	}

	getState(): ShoferNodesState {
		return { nodes: this.buildNodeViews(), activeNodeId: this.activeNodeId() }
	}

	/** The pool the controller drives (Level 2 routes task creation through it). */
	get executorPool(): ExecutorPool {
		return this.pool
	}

	dispose(): void {
		for (const conn of this.connections.values()) conn.dispose()
		this.connections.clear()
		this.listeners.clear()
	}

	// ── internals ──────────────────────────────────────────────────────────────

	private activeNodeId(): string {
		// L1: no pooled task routing yet → Local owns the active task. Phase 2 wires
		// `pool.ownerOf(activeTaskId)`.
		return LOCAL_NODE_ID
	}

	private async startConnection(def: ShoferNodeDef): Promise<void> {
		if (def.kind !== "remote" || !def.host) return
		this.teardownConnection(def.id)
		const token = (await this.context.secrets.get(tokenKey(def.id))) ?? undefined
		const baseUrl = `${def.tls ? "https" : "http"}://${def.host}`
		const conn = this.createConnection({ baseUrl, token, controllerVersion: this.controllerVersion })
		this.connections.set(def.id, conn)
		conn.onStatusChange(() => this.onConnStatus(def.id))
		await conn.connect()
	}

	private onConnStatus(id: string): void {
		const conn = this.connections.get(id)
		if (!conn) return
		const def = this.getDef(id)
		const eligible = conn.status === "connected" && !!conn.api && !def?.disabled
		const inPool = this.pool.has(id)
		if (eligible && !inPool) {
			this.pool.add({ id, api: conn.api! })
		} else if (!eligible && inPool) {
			this.pool.remove(id)
		}
		this.fireChange()
	}

	private teardownConnection(id: string): void {
		const conn = this.connections.get(id)
		if (!conn) return
		conn.dispose()
		this.connections.delete(id)
		if (this.pool.has(id)) this.pool.remove(id)
	}

	private loadDefs(): ShoferNodeDef[] {
		const stored = this.context.globalState.get<ShoferNodeDef[]>(DEFS_KEY)
		return Array.isArray(stored) ? stored.map((d) => ({ ...d })) : []
	}

	private async persist(): Promise<void> {
		await this.context.globalState.update(DEFS_KEY, this.defs)
	}

	private getDef(id: string): ShoferNodeDef | undefined {
		return this.defs.find((d) => d.id === id)
	}

	private setDef(def: ShoferNodeDef): void {
		const idx = this.defs.findIndex((d) => d.id === def.id)
		if (idx === -1) this.defs.push(def)
		else this.defs[idx] = def
	}

	private fireChange(): void {
		for (const cb of [...this.listeners]) cb()
	}
}
