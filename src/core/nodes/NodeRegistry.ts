import os from "node:os"

import * as vscode from "vscode"

import {
	type AgentApi,
	type Event,
	type GlobalSettings,
	type LoadBalancerPolicy,
	type LoadSample,
	type ProviderSettings,
	type ServerEvent,
	type ShoferAPI,
	type ShoferMessage,
	type ShoferNodeConnState,
	type ShoferNodeDef,
	type ShoferNodeRequest,
	type ShoferNodeView,
	type ShoferNodesState,
	type SyncedPluginState,
	type SyncedSecrets,
	type SyncedSettings,
	type TokenUsage,
	ExecutorPool,
	LOCAL_NODE_ID,
	ShoferEventName,
	SYNCED_SECRET_KEYS,
	SYNCED_SETTINGS_KEYS,
	computeConfigVersion,
	defaultModeSlug,
	pickSyncedSecrets,
	pickSyncedSettings,
} from "@shofer/types"
import { NodeConnection, ShoferApiAgent, configLog } from "@shofer/core"

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
	/** The node's latest load sample (from the health ping), for the LB policy. */
	readonly load: LoadSample | undefined
	/** The node's last-applied config-sync version (config_sync §6), echoed on /health. */
	readonly configVersion: string | undefined
	/** Whether the node accepts controller config (config_sync §Part A); `false` ⇒ exempt from gating. */
	readonly managed: boolean
	readonly api: AgentApi | undefined
	onStatusChange(cb: (state: ShoferNodeConnState) => void): () => void
	/** Record a just-pushed config version so the node is pool-assignable without waiting for the next ping. */
	markConfigApplied(version: string): void
	connect(): Promise<void>
	disconnect(): void
	dispose(): void
}

/**
 * The minimal settings surface the registry reads to resolve + subscribe to the
 * controller-authoritative synced slice (config_sync §4c). Satisfied by
 * {@link import("../config/ContextProxy.js").ContextProxy}; declared locally to avoid
 * an import cycle with the config layer.
 */
export interface SyncedConfigSource {
	getValues(): Partial<GlobalSettings>
	/**
	 * Live read of a single secret. The registry pulls only {@link SYNCED_SECRET_KEYS}
	 * through this, so the source hands over one credential at a time rather than
	 * exposing its whole secret bag. `ContextProxy` satisfies this as-is.
	 */
	getSecret(key: (typeof SYNCED_SECRET_KEYS)[number]): string | undefined
	onDidChange: Event<{ key: string }>
}

/**
 * Where the controller's **plugin** slice comes from (config_sync, plugin half).
 *
 * Separate from {@link SyncedConfigSource} because plugin state is not in the global
 * settings schema and is not the controller's to shape: the source asks each opted-in
 * plugin what a node should receive. Absent ⇒ nodes get no plugin state, which is the
 * pre-plugin-sync behaviour.
 */
export interface PluginSyncSource {
	/** The controller→node slice for every plugin that declares `syncConfig`. */
	currentPluginSlice(): Promise<SyncedPluginState>
	/** Fires when a synced plugin's config or credentials changed. */
	onDidChange?: Event<void>
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
		cwd?: string,
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
	/** Directory the task runs in, when a plugin placed it somewhere other than the workspace. */
	cwd?: string
	/** Optional caller-preferred node; honored when enabled+assignable, else round-robin. */
	preferredNodeId?: string
	/**
	 * The controller-resolved API Configuration for this task, shipped to a REMOTE
	 * owner so the task runs on the same provider/model the front-end picked (a node
	 * without a CLI override applies it; one with an override ignores it). Unused on
	 * the Local path — the in-process task reads the provider's live config directly.
	 */
	apiConfiguration?: ProviderSettings
}

export interface NodeRegistryOptions {
	context: vscode.ExtensionContext
	localApi: ShoferAPI
	controllerVersion: string
	/**
	 * Controller-authoritative settings source (config_sync §4c). The registry reads
	 * the synced slice from it and subscribes to changes to push config to remote
	 * nodes. Optional so unit tests can construct the registry without a ContextProxy;
	 * when absent, config sync is inert (no desired version → the pool is never gated).
	 */
	configSource?: SyncedConfigSource
	/**
	 * Source of the plugin half of the synced config. Wired by the extension, where the
	 * plugin manager lives; omitted in tests that do not exercise plugin sync.
	 */
	pluginSyncSource?: PluginSyncSource
}

export interface NodeRegistryDeps {
	/** Override the connection factory (tests inject a fake). */
	createConnection?: NodeConnectionFactory
	/** Override the Local agent adapter (tests avoid needing a real ShoferAPI). */
	localAgent?: AgentApi
}

const DEFS_KEY = "shoferNodes.defs"
const tokenKey = (id: string): string => `shoferNode.token.${id}`

/** VS Code setting selecting the ExecutorPool's new-task load-balancing policy. */
const LOAD_BALANCER_SETTING = "shofer.nodes.loadBalancer"
/** Valid {@link LoadBalancerPolicy} values (guards the settings read). */
const LOAD_BALANCER_POLICIES: readonly LoadBalancerPolicy[] = [
	"round-robin",
	"least-load-1m",
	"least-load-5m",
	"least-load-15m",
]

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
	/** Every attached provider (sidebar + editor-tab). All get `shoferNodes` via `onChange`. */
	private readonly providers = new Set<NodeProviderHost>()
	/** Per-remote-task render buffers (L2). Local tasks are NEVER shadowed. */
	private readonly shadows = new Map<string, RemoteTaskShadow>()
	/**
	 * Per-view shadow focus: the remote-task shadow each view (provider) is currently
	 * rendering. A view ABSENT from this map renders the GLOBAL local current task —
	 * byte-for-byte the pre-per-view behavior. This split is what lets the sidebar
	 * show a local task while a separate editor tab streams a remote-node shadow
	 * without the two clobbering each other. The map key IS the provider object
	 * reference, so no separate view id is needed.
	 */
	private readonly focusedShadows = new Map<NodeProviderHost, string>()
	/** Disposes the `onDidChangeConfiguration` subscription for the LB policy. */
	private readonly configDisposable: vscode.Disposable
	/** Controller-authoritative settings source (config_sync §4c); undefined disables sync. */
	private readonly configSource?: SyncedConfigSource
	/** Controller-authoritative plugin-state source; undefined ⇒ nodes get no plugin slice. */
	private readonly pluginSyncSource?: PluginSyncSource
	/**
	 * The last plugin slice built from {@link pluginSyncSource}.
	 *
	 * Cached because building it is async (each plugin may shape its own slice) while the
	 * settings slice — and every caller that pairs the two — is synchronous. Refreshed
	 * whenever plugin state changes, and once at wiring time.
	 */
	private pluginSlice: SyncedPluginState = {}
	/** Disposes the `pluginSyncSource.onDidChange` subscription. */
	private pluginChangeDisposable?: { dispose(): void }
	/** Disposes the `configSource.onDidChange` subscription for config-sync broadcasts. */
	private configChangeDisposable?: { dispose(): void }
	/** The controller's current desired config-sync version (config_sync §6). */
	private desiredConfigVersion?: string
	private static readonly SHADOW_CHANGED_FILES_DEBOUNCE_MS = 500

	/**
	 * The keys that are actually synced — used to filter change events. Includes the
	 * synced SECRET keys as well: rotating a code-index credential must re-broadcast,
	 * and a secret change is delivered through the same `onDidChange` stream.
	 */
	private static readonly SYNCED_KEYS = new Set<string>([
		...(SYNCED_SETTINGS_KEYS as readonly string[]),
		...(SYNCED_SECRET_KEYS as readonly string[]),
	])

	// ── shared singleton (mirrors ContextProxy / CodeIndexManager) ───────────────
	private static _instance: NodeRegistry | undefined

	/**
	 * The process-wide shared registry. Constructed once (by the sidebar activation,
	 * which owns the live {@link ShoferAPI}); the editor-tab provider retrieves the
	 * SAME instance with no args so both webviews share one pool + node state. Pass
	 * `opts` to lazily construct on first call; call with no args to fetch (or
	 * `undefined` if not yet constructed).
	 */
	static getInstance(opts?: NodeRegistryOptions, deps?: NodeRegistryDeps): NodeRegistry | undefined {
		if (!NodeRegistry._instance && opts) {
			NodeRegistry._instance = new NodeRegistry(opts, deps)
		}
		return NodeRegistry._instance
	}

	/** Dispose + clear the shared instance (extension deactivation / test isolation). */
	static resetInstance(): void {
		NodeRegistry._instance?.dispose()
		NodeRegistry._instance = undefined
	}

	constructor(opts: NodeRegistryOptions, deps: NodeRegistryDeps = {}) {
		this.context = opts.context
		this.controllerVersion = opts.controllerVersion
		this.configSource = opts.configSource
		this.pluginSyncSource = opts.pluginSyncSource
		this.localAgent = deps.localAgent ?? new ShoferApiAgent(opts.localApi)
		this.createConnection = deps.createConnection ?? ((o) => new NodeConnection(o))

		// Load persisted defs and guarantee a Local entry (first).
		this.defs = this.loadDefs()
		if (!this.defs.some((d) => d.id === LOCAL_NODE_ID)) {
			this.defs.unshift({ id: LOCAL_NODE_ID, kind: "local", label: "Local" })
		}

		// Register Local at construction; reflect its persisted disabled flag. The
		// Local load accessor reads this host's live loadavg/cpu count on demand
		// (node:os is fine here — NodeRegistry is Node-side, unlike @shofer/types).
		this.pool.add({
			id: LOCAL_NODE_ID,
			api: this.localAgent,
			load: (): LoadSample => ({ loadavg: os.loadavg() as [number, number, number], cpus: os.cpus().length }),
			// The Local executor reads controller state in-process — NEVER version-gated
			// (and never pushed config, which would re-apply the controller's own settings).
			managed: () => false,
		})
		if (this.getDef(LOCAL_NODE_ID)?.disabled) this.pool.setDisabled(LOCAL_NODE_ID, true)

		// Apply the persisted load-balancer policy + track config changes.
		this.pool.setPolicy(this.readLoadBalancerPolicy())
		this.configDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(LOAD_BALANCER_SETTING)) this.pool.setPolicy(this.readLoadBalancerPolicy())
		})

		// L2: demux the merged pool feed into per-remote-task shadows + webview render.
		this.pool.subscribe((event) => this.onPoolEvent(event))

		// config_sync §4c: seed the desired config version from controller state and
		// keep the pool's gate current on every synced-settings change. Inert without a
		// configSource (unit tests) — desiredConfigVersion stays undefined ⇒ no gating.
		if (this.configSource) {
			this.desiredConfigVersion = computeConfigVersion(
				this.currentSyncedSlice(),
				this.currentSyncedSecrets(),
				this.pluginSlice,
			)
			this.pool.setDesiredConfigVersion(this.desiredConfigVersion)
			this.configChangeDisposable = this.configSource.onDidChange((e) => {
				// Only react to keys that are actually synced (ignore frontend-only churn).
				if (NodeRegistry.SYNCED_KEYS.has(e.key)) this.recomputeAndBroadcast()
			})
		}

		// The plugin half of the same sync. Built asynchronously (each plugin may shape
		// its own slice), so it lands via the cache and a re-broadcast rather than being
		// read inline above; until it does, nodes simply hold no plugin state.
		if (this.pluginSyncSource) {
			void this.refreshPluginSlice()
			this.pluginChangeDisposable = this.pluginSyncSource.onDidChange?.(() => {
				void this.refreshPluginSlice()
			})
		}
	}

	/**
	 * Rebuild the cached plugin slice and re-broadcast if it changed.
	 *
	 * Compared by value, not fired blindly: a plugin reload or an unrelated settings save
	 * would otherwise bump the config version and make every node re-apply an identical
	 * slice.
	 */
	private async refreshPluginSlice(): Promise<void> {
		try {
			const next = (await this.pluginSyncSource?.currentPluginSlice()) ?? {}
			if (JSON.stringify(next) === JSON.stringify(this.pluginSlice)) return
			this.pluginSlice = next
			this.recomputeAndBroadcast()
		} catch (e) {
			configLog.warn(`plugin config sync build failed: ${e instanceof Error ? e.message : String(e)}`)
		}
	}

	/** Read the `shofer.nodes.loadBalancer` setting (default `round-robin`). */
	private readLoadBalancerPolicy(): LoadBalancerPolicy {
		const raw = vscode.workspace.getConfiguration().get<string>(LOAD_BALANCER_SETTING, "round-robin")
		return LOAD_BALANCER_POLICIES.includes(raw as LoadBalancerPolicy) ? (raw as LoadBalancerPolicy) : "round-robin"
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
	 * Attach a controller-side provider host (Level 2). Every attached provider
	 * receives `shoferNodes` state (via its own `onChange` registration). A view
	 * that starts a remote task focuses its own shadow (see {@link routeNewTask});
	 * an attached view with no focused shadow renders the global local current task.
	 */
	attachProvider(provider: NodeProviderHost): void {
		this.providers.add(provider)
	}

	/**
	 * Detach a provider (its webview closed). The closed view releases its shadow
	 * focus; the shadow itself keeps buffering in {@link shadows} for any other view.
	 */
	detachProvider(provider: NodeProviderHost): void {
		this.providers.delete(provider)
		this.focusedShadows.delete(provider)
	}

	/** True when at least one *remote* executor is currently assignable (enabled + connected). */
	hasEnabledRemote(): boolean {
		return this.pool.assignableIds().some((id) => id !== LOCAL_NODE_ID)
	}

	/**
	 * True when the Local executor is admin-disabled. The controller itself stays fully
	 * alive regardless (UI, node relay, indexing) — disabled means Local must not pick
	 * up NEW tasks. Callers that would start a task in-process without consulting the
	 * pool (the webview's local fast path) must check this and route instead, so the
	 * refusal in {@link routeNewTask} is reachable.
	 */
	isLocalDisabled(): boolean {
		return this.getDef(LOCAL_NODE_ID)?.disabled ?? false
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
	async routeNewTask(input: RouteNewTaskInput, initiator?: NodeProviderHost): Promise<string | undefined> {
		// The view that issued this newTask is where the task renders. Ensure it's
		// tracked so its shadow focus (remote owner) / local render (Local owner)
		// lands there. Falls back to the first attached view when unspecified.
		if (initiator) this.providers.add(initiator)
		const view = initiator ?? this.providers.values().next().value
		const assignable = this.pool.assignableIds()
		const preferred =
			input.preferredNodeId && assignable.includes(input.preferredNodeId) ? input.preferredNodeId : undefined
		// A preferred pick must NOT also advance the round-robin cursor.
		const owner = preferred ?? this.pool.pickNext() ?? LOCAL_NODE_ID

		// An admin-disabled Local is excluded from `assignable()`, so the only way it
		// can become owner is this bare fallback — meaning nothing else was assignable.
		// Refuse with a clear error (surfaced by the caller's notifier) instead of
		// silently running the task on the executor the admin disabled.
		if (owner === LOCAL_NODE_ID && this.isLocalDisabled()) {
			throw new Error(
				"The Local executor is disabled and no remote node is available to run this task. " +
					"Enable the Local executor or connect/enable a remote node in Settings → Shofer Nodes.",
			)
		}

		if (owner === LOCAL_NODE_ID) {
			if (!view) throw new Error("NodeRegistry: no provider attached for the Local new-task path")
			const taskId = await view.createManagedTask(undefined, input.prompt, input.images, input.cwd, {
				mode: input.mode,
				apiConfigName: input.apiConfigName,
			})
			// Record Local ownership so ownerOf()/activeNodeId() report Local. The
			// task ran fully in-process — never through the pool's createTask.
			if (taskId) this.pool.assignOwner(taskId, LOCAL_NODE_ID)
			return taskId
		}

		// Remote owner: the node runs the task; we only buffer/render it (Stage B).
		// The INITIATING view focuses the new shadow (per-view focus) — other views
		// are untouched and keep showing whatever they were on.
		const { taskId } = await this.pool.createTaskOn(owner, {
			prompt: input.prompt,
			// `mode` is required on the AgentApi contract; routeNewTask's input keeps
			// the historical optional-with-default semantics, so resolve the default
			// here for the remote executor (the Local path defaults it downstream).
			mode: input.mode ?? defaultModeSlug,
			apiConfiguration: input.apiConfiguration,
		})
		this.ensureShadow(taskId, owner, input.prompt)
		if (view) this.focusShadow(view, taskId)
		return taskId
	}

	// ── remote-task shadows (L2 render demux) ────────────────────────────────────

	/** The remote shadow the given view is currently rendering, if any (per-view). */
	getFocusedShadow(provider: NodeProviderHost): RemoteTaskShadow | undefined {
		const id = this.focusedShadows.get(provider)
		return id ? this.shadows.get(id) : undefined
	}

	/** Every view currently focused on `taskId` — the fan-out set for a shadow's deltas. */
	private viewsFocusedOn(taskId: string): NodeProviderHost[] {
		const views: NodeProviderHost[] = []
		for (const [p, id] of this.focusedShadows) if (id === taskId) views.push(p)
		return views
	}

	/** Whether `taskId` is a remote-owned shadow task (vs. a local in-process task). */
	isShadow(taskId: string): boolean {
		return this.shadows.has(taskId)
	}

	/**
	 * Answer a remote shadow task's outstanding `ask`, routed over the pool to the
	 * owning executor (the reverse of the demuxed `ask` render). This is the
	 * controller side of interactive remote approvals: a webview approve/deny for a
	 * shadow task lands here instead of the in-process `handleWebviewAskResponse`.
	 */
	async respondToAsk(
		taskId: string,
		response: { askResponse: string; text?: string; images?: string[]; askId?: string },
	): Promise<void> {
		await this.pool.respondToAsk(taskId, response)
	}

	// ── remote reverse data channel (Shofer Nodes L3) ────────────────────────────
	// Route a plugin request for a shadow (remote) task over the pool to the owning
	// executor — the one channel every plugin-owned per-task feature travels on.

	/** Reach a plugin running on the executor that owns `taskId` (generic plugin RPC). */
	pluginRequest(taskId: string, plugin: string, method: string, params?: unknown): Promise<unknown> {
		return this.pool.pluginRequest(taskId, plugin, method, params)
	}

	/**
	 * Rebuild a shadow after the executor rewound its task — e.g. a snapshot plugin
	 * restoring an earlier point (Shofer Nodes L3).
	 * The executor rewound + reinitialized its task, so its stale post-rewind
	 * `Message` stream will repopulate the shadow: clear the buffered conversation and
	 * re-post init state for the focused shadow.
	 */
	async rebuildShadow(taskId: string): Promise<void> {
		const shadow = this.shadows.get(taskId)
		if (!shadow) return
		shadow.clearMessages()
		for (const view of this.viewsFocusedOn(taskId)) await view.postInitState()
	}

	/** Focus a remote shadow IN A SINGLE VIEW and switch that view's webview to it. */
	focusShadow(provider: NodeProviderHost, taskId: string): void {
		if (!this.shadows.has(taskId)) return
		this.focusedShadows.set(provider, taskId)
		void provider.postInitState()
		this.fireChange()
	}

	/**
	 * Clear a view's remote-shadow focus (e.g. it switched back to a local task).
	 * Reverts THAT view to the global local current task via a fresh full-state push.
	 */
	clearShadowFocus(provider: NodeProviderHost): void {
		if (!this.focusedShadows.has(provider)) return
		this.focusedShadows.delete(provider)
		void provider.postInitState()
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
				shadow.applyMessageDelta(payload.action, payload.message)
				// Fan the delta out to EVERY view focused on this shadow (per-view focus).
				const focusedViews = this.viewsFocusedOn(shadow.taskId)
				if (focusedViews.length > 0) {
					const post =
						payload.action === "created"
							? { type: "shoferMessageAppended", shoferMessage: payload.message }
							: { type: "messageUpdated", shoferMessage: payload.message }
					for (const view of focusedViews) void view.postMessageToWebview(post)
				}
				return
			}
			case ShoferEventName.TaskTokenUsageUpdated: {
				const shadow = this.shadows.get(args[0] as string)
				const usage = args[1] as TokenUsage | undefined
				if (shadow && usage) {
					shadow.setTokenUsage(usage)
					// Refresh the header/token summary for every view focused on this shadow.
					for (const view of this.viewsFocusedOn(shadow.taskId)) void view.postInitState()
				}
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
			case "setLoadBalancer":
				return this.setLoadBalancer(req.policy)
		}
	}

	/**
	 * Persist + apply the pool's new-task load-balancing policy. Writes the
	 * `shofer.nodes.loadBalancer` setting (Global) AND applies it to the pool
	 * immediately + fires a change, so the panel updates without waiting for the
	 * `onDidChangeConfiguration` listener to round-trip. That listener re-reads
	 * and re-applies the same policy (idempotent — {@link ExecutorPool.setPolicy}
	 * is a plain assignment), so the double-apply is harmless.
	 */
	async setLoadBalancer(policy: LoadBalancerPolicy): Promise<void> {
		await vscode.workspace
			.getConfiguration("shofer.nodes")
			.update("loadBalancer", policy, vscode.ConfigurationTarget.Global)
		this.pool.setPolicy(policy)
		this.fireChange()
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
					// A disabled node is out of the pool — never "active", even if it was
					// the last-resolved active node (avoids showing active + disabled at once).
					isActive: !disabled && activeNodeId === LOCAL_NODE_ID,
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
				isActive: !disabled && activeNodeId === def.id,
				disabled,
				hasToken: this.hasTokenCache.has(def.id),
			}
		})
	}

	getState(): ShoferNodesState {
		return {
			nodes: this.buildNodeViews(),
			activeNodeId: this.activeNodeId(),
			loadBalancer: this.pool.getPolicy(),
		}
	}

	/** The pool the controller drives (Level 2 routes task creation through it). */
	get executorPool(): ExecutorPool {
		return this.pool
	}

	dispose(): void {
		this.configDisposable.dispose()
		this.configChangeDisposable?.dispose()
		this.pluginChangeDisposable?.dispose()
		for (const conn of this.connections.values()) conn.dispose()
		this.connections.clear()
		this.listeners.clear()
		this.focusedShadows.clear()
	}

	// ── internals ──────────────────────────────────────────────────────────────

	private activeNodeId(): string {
		// L2: the single global `shoferNodes` badge shows ONE active node. With per-view
		// shadow focus this is inherently ambiguous, so we resolve it deterministically:
		// if ANY view focuses a remote shadow, the active node owns that shadow (first
		// map entry); otherwise it owns the global local current task (first attached
		// view). A task the pool never assigned (the pure local-only path) has no owner
		// → Local. This lights `isActive` in buildNodeViews + the TaskHeader badge.
		const firstFocusedShadowId = this.focusedShadows.values().next().value as string | undefined
		const localTaskId = this.providers.values().next().value?.getCurrentTask()?.taskId
		const focusedTaskId = firstFocusedShadowId ?? localTaskId
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
			this.pool.add({
				id,
				api: conn.api!,
				load: () => conn.load,
				configVersion: () => conn.configVersion,
				managed: () => conn.managed,
			})
		} else if (!eligible && inPool) {
			this.pool.remove(id)
		}
		// config_sync §4c: push the current slice to a node that (re)connected and isn't
		// already at the desired version. Idempotent; the health-ping loop re-sends on drift.
		if (this.configSource && conn.status === "connected" && conn.api) {
			const slice = this.currentSyncedSlice()
			const secrets = this.currentSyncedSecrets()
			const version = this.desiredConfigVersion ?? computeConfigVersion(slice, secrets, this.pluginSlice)
			if (conn.configVersion !== version) void this.pushConfig(id, conn, slice, version, secrets)
		}
		this.fireChange()
	}

	// ── controller→node config sync (config_sync §4c) ────────────────────────────

	/**
	 * The controller-authoritative synced settings slice, resolved live from the source.
	 *
	 * Nothing is rewritten on the way out any more. The one rule that used to live here —
	 * "a node queries the shared code index but never writes to it" — belongs to the
	 * plugin that owns the index, and it applies that itself when the controller asks it
	 * for its node slice (`"node-config"`, `config_sync` §4b-2).
	 */
	private currentSyncedSlice(): SyncedSettings {
		return pickSyncedSettings(this.configSource?.getValues() ?? {})
	}

	/**
	 * The controller-authoritative synced secrets slice (the credential counterpart of
	 * {@link currentSyncedSlice}). Pulled key-by-key through the config source so only
	 * the allow-listed credentials ever leave the controller.
	 */
	private currentSyncedSecrets(): SyncedSecrets {
		const source = this.configSource
		if (!source) return {}
		const bag: Record<string, string | undefined> = {}
		for (const key of SYNCED_SECRET_KEYS) {
			bag[key] = source.getSecret(key)
		}
		return pickSyncedSecrets(bag)
	}

	/**
	 * Recompute the desired config version, update the pool's gate, and broadcast the new
	 * slice to every connected REMOTE node. Never touches the Local executor (it reads
	 * controller state in-process). Called on every synced-settings change.
	 */
	private recomputeAndBroadcast(): void {
		const slice = this.currentSyncedSlice()
		const secrets = this.currentSyncedSecrets()
		const version = computeConfigVersion(slice, secrets, this.pluginSlice)
		this.desiredConfigVersion = version
		this.pool.setDesiredConfigVersion(version)
		for (const [id, conn] of this.connections) {
			if (conn.status === "connected" && conn.api) void this.pushConfig(id, conn, slice, version, secrets)
		}
		this.fireChange()
	}

	/**
	 * Push one config slice to a single remote node. On success, mark the connection as
	 * applied so it becomes pool-assignable promptly (the health echo stays the ongoing
	 * source of truth). On failure, log and let the health-ping reconciliation retry.
	 */
	private async pushConfig(
		id: string,
		conn: INodeConnection,
		slice: SyncedSettings,
		version: string,
		secrets: SyncedSecrets,
	): Promise<void> {
		try {
			await conn.api!.applyConfig(slice, version, secrets, this.pluginSlice)
			conn.markConfigApplied(version)
		} catch (e) {
			configLog.warn(`config sync push to node ${id} failed: ${e instanceof Error ? e.message : String(e)}`)
		}
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
