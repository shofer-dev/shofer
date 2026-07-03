import * as vscode from "vscode"

import {
	type AgentApi,
	type ServerEvent,
	type ShoferAPI,
	type ShoferMessage,
	type ShoferNodeConnState,
	type ShoferNodeDef,
	type ShoferNodeRequest,
	type ShoferNodeView,
	type ShoferNodesState,
	ExecutorPool,
	LOCAL_NODE_ID,
	ShoferEventName,
} from "@shofer/types"
import { NodeConnection, ShoferApiAgent } from "@shofer/core"

import { RemoteTaskShadow } from "./RemoteTaskShadow.js"

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

/**
 * The minimal slice of {@link ShoferProvider} the registry drives (Level 2). Kept
 * as an interface so the registry stays unit-testable (tests inject a fake) and
 * to avoid an import cycle with the provider. `createManagedTask` runs the Local
 * in-process new-task path and returns the new task id; `getCurrentTask` and
 * `postMessageToWebview` back the shadow render + focus logic (Stages B/C).
 */
export interface NodeProviderHost {
	createManagedTask(
		name?: string,
		text?: string,
		images?: string[],
		worktreeDir?: string,
		seeds?: { mode?: string; apiConfigName?: string },
	): Promise<string | undefined>
	getCurrentTask(): { taskId?: string } | undefined
	postMessageToWebview(message: unknown): Promise<void> | void
	/** Push a full ExtensionState snapshot (used to switch the webview to a focused shadow). */
	postInitState(): Promise<void>
}

/** Options for {@link NodeRegistry.routeNewTask} (the pooled new-task entry point). */
export interface RouteNewTaskInput {
	prompt: string
	images?: string[]
	mode?: string
	apiConfigName?: string
	worktreeDir?: string
	/** Optional caller-preferred node; honored when enabled+assignable, else round-robin. */
	preferredNodeId?: string
}

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
	private provider?: NodeProviderHost
	/** Per-remote-task render buffers (L2). Local tasks are NEVER shadowed. */
	private readonly shadows = new Map<string, RemoteTaskShadow>()
	/** The remote shadow the webview is currently showing (drives the render override). */
	private focusedShadowId?: string

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

		// L2: demux the merged pool feed into per-remote-task shadows + webview render.
		this.pool.subscribe((event) => this.onPoolEvent(event))
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

	/**
	 * Attach the controller-side provider host (Level 2). The registry needs it to
	 * run the Local in-process new-task path (bypassing the pool) and to push
	 * remote-shadow render deltas to the webview. Idempotent; the last attach wins.
	 */
	attachProvider(provider: NodeProviderHost): void {
		this.provider = provider
	}

	/** True when at least one *remote* executor is currently assignable (enabled + connected). */
	hasEnabledRemote(): boolean {
		return this.pool.assignableIds().some((id) => id !== LOCAL_NODE_ID)
	}

	/**
	 * Route a webview new-task through the pool (Level 2 load-balancing).
	 *
	 * Owner selection: an enabled+assignable `preferredNodeId` wins; otherwise the
	 * pool's round-robin (`pickNext`). The **Local** owner takes the IN-PROCESS
	 * path (`provider.createManagedTask`) and bypasses the pool entirely — the pool
	 * only records ownership via `assignOwner`. This is the recursion guard: the
	 * webview→pool→ShoferApiAgent.createTask→api.startNewTask→provider.createTask
	 * loop can never form for a Local pick. A remote owner dispatches through
	 * `pool.createTaskOn`, which runs the task on that node.
	 *
	 * Returns the new task id (or `undefined` if the Local path failed to create).
	 */
	async routeNewTask(input: RouteNewTaskInput): Promise<string | undefined> {
		const assignable = this.pool.assignableIds()
		const preferred =
			input.preferredNodeId && assignable.includes(input.preferredNodeId) ? input.preferredNodeId : undefined
		// A preferred pick must NOT also advance the round-robin cursor.
		const owner = preferred ?? this.pool.pickNext() ?? LOCAL_NODE_ID

		if (owner === LOCAL_NODE_ID) {
			if (!this.provider) throw new Error("NodeRegistry: no provider attached for the Local new-task path")
			const taskId = await this.provider.createManagedTask(undefined, input.prompt, input.images, input.worktreeDir, {
				mode: input.mode,
				apiConfigName: input.apiConfigName,
			})
			// Record Local ownership so ownerOf()/activeNodeId() report Local. The
			// task ran fully in-process — never through the pool's createTask.
			if (taskId) this.pool.assignOwner(taskId, LOCAL_NODE_ID)
			return taskId
		}

		// Remote owner: the node runs the task; we only buffer/render it (Stage B).
		const { taskId } = await this.pool.createTaskOn(owner, { prompt: input.prompt })
		this.ensureShadow(taskId, owner, input.prompt)
		this.focusShadow(taskId)
		return taskId
	}

	// ── remote-task shadows (L2 render demux) ────────────────────────────────────

	/** The remote shadow the webview is currently rendering, if any. */
	getFocusedShadow(): RemoteTaskShadow | undefined {
		return this.focusedShadowId ? this.shadows.get(this.focusedShadowId) : undefined
	}

	/** Make a remote shadow the focused task and switch the webview to it. */
	focusShadow(taskId: string): void {
		if (!this.shadows.has(taskId)) return
		this.focusedShadowId = taskId
		void this.provider?.postInitState()
		this.fireChange()
	}

	/** Clear remote-shadow focus (e.g. the user switched back to a local task). */
	clearShadowFocus(): void {
		if (this.focusedShadowId === undefined) return
		this.focusedShadowId = undefined
		this.fireChange()
	}

	private ensureShadow(taskId: string, executorId: string, prompt?: string): RemoteTaskShadow {
		let shadow = this.shadows.get(taskId)
		if (!shadow) {
			shadow = new RemoteTaskShadow({
				taskId,
				executorId,
				nodeLabel: this.getDef(executorId)?.label ?? executorId,
				prompt,
			})
			this.shadows.set(taskId, shadow)
		}
		return shadow
	}

	/**
	 * Demux a single (executor-tagged) event off the merged pool feed.
	 *
	 * FIRST LINE INVARIANT: Local-tagged events return immediately — a Local task
	 * renders through its own in-process {@link import("../task/Task.js").Task}
	 * path, so re-rendering it here would double-emit. Only remote executors reach
	 * the shadow machinery.
	 */
	private onPoolEvent(event: ServerEvent): void {
		const executorId = event.executorId as string | undefined
		if (!executorId || executorId === LOCAL_NODE_ID) return

		const args = (event.args as unknown[]) ?? []
		switch (event.type) {
			case ShoferEventName.TaskCreated: {
				const taskId = args[0] as string
				if (taskId) this.ensureShadow(taskId, executorId)
				this.fireChange()
				return
			}
			case ShoferEventName.TaskStarted: {
				this.shadows.get(args[0] as string)?.markStarted()
				return
			}
			case ShoferEventName.Message: {
				const payload = args[0] as
					| { taskId: string; action: "created" | "updated"; message: ShoferMessage }
					| undefined
				if (!payload?.taskId || !payload.message) return
				const shadow = this.ensureShadow(payload.taskId, executorId)
				const wasBlocked = shadow.blockedOnAsk
				shadow.applyMessageDelta(payload.action, payload.message)
				// Mirror the local gate: only push deltas for the focused shadow.
				if (this.focusedShadowId === shadow.taskId) {
					void this.provider?.postMessageToWebview(
						payload.action === "created"
							? { type: "shoferMessageAppended", shoferMessage: payload.message }
							: { type: "messageUpdated", shoferMessage: payload.message },
					)
				}
				// A newly-detected non-auto-approvable ask changes the node view
				// (surface the "cannot respond to remote ask" state) — re-push nodes.
				if (!wasBlocked && shadow.blockedOnAsk) this.fireChange()
				return
			}
			case ShoferEventName.TaskCompleted: {
				this.shadows.get(args[0] as string)?.markCompleted()
				this.fireChange()
				return
			}
			case ShoferEventName.TaskAborted: {
				this.shadows.get(args[0] as string)?.markAborted()
				this.fireChange()
				return
			}
			case ShoferEventName.TaskError: {
				this.shadows.get(args[0] as string)?.markError(args[1] as string | undefined)
				this.fireChange()
				return
			}
		}
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
		// L2: the active node OWNS the focused task. The focused task is the focused
		// remote shadow (if any), else the provider's current in-process task. A task
		// the pool never assigned (the pure local-only path, which bypasses the pool)
		// has no owner → Local. This is what lights `isActive` in buildNodeViews and
		// the "Executing on remote node" badge in TaskHeader.
		const focusedTaskId = this.focusedShadowId ?? this.provider?.getCurrentTask()?.taskId
		if (!focusedTaskId) return LOCAL_NODE_ID
		return this.pool.ownerOf(focusedTaskId) ?? LOCAL_NODE_ID
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
