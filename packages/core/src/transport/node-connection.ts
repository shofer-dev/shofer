import type { AgentApi, LoadSample, ShoferNodeConnState } from "@shofer/types"
import { TypedEmitter } from "@shofer/types"

import { MAX_EXPONENTIAL_BACKOFF_SECONDS } from "../constants.js"
import { ShoferHttpClient } from "./http-client.js"

/**
 * Controller-side status layer for a single remote executor (Shofer Nodes L1).
 *
 * A remote node is a `shofer serve` process on another host running the same
 * bundle. This class owns the *connection lifecycle* to one such node over the
 * existing HTTP/SSE transport and projects it into the {@link ShoferNodeConnState}
 * the webview renders (plus latency / agent version / error). It is fully
 * transport-agnostic: `fetch` and all timers are injectable, so every state
 * transition is unit-testable without real sockets or real time.
 *
 * Handshake (a single round-trip gives liveness + version + auth):
 *   `connect()` → `connecting` → `GET /api/v1/whoami` (Bearer token) →
 *     - 200 & version === controllerVersion → `connected` (holds a
 *       {@link ShoferHttpClient} as the live {@link AgentApi})
 *     - 200 & version differs            → `version-mismatch` (api withheld)
 *     - 401                              → `unauthorized`
 *     - network / other                 → `error`
 *
 * While connected, a periodic `GET /health` ping updates `latencyMs`; a ping
 * failure drops to `reconnecting` and retries `connect()` with capped
 * exponential backoff, giving up to `error` after `maxReconnectAttempts`.
 */
export interface NodeConnectionOptions {
	/** HTTP(S) base of the remote executor, e.g. `http://10.0.0.5:30099`. */
	baseUrl: string
	/** Bearer token stored for this node (SecretStorage on the Cat-II side). */
	token?: string
	/** The controller's build version; the node must report the exact same one. */
	controllerVersion: string
	/** Injected fetch (tests / non-global). */
	fetch?: typeof fetch
	/** Health-ping interval while connected (ms). Default {@link DEFAULT_PING_INTERVAL_MS}. */
	pingIntervalMs?: number
	/** Base delay (ms) for reconnect backoff. Default {@link DEFAULT_RECONNECT_BASE_MS}. */
	reconnectBaseMs?: number
	/** Max reconnect attempts before giving up to `error`. Default {@link DEFAULT_MAX_RECONNECT_ATTEMPTS}. */
	maxReconnectAttempts?: number
	/** Injectable timers so status timing doesn't wait real time in tests. */
	setTimeout?: (cb: () => void, ms: number) => unknown
	clearTimeout?: (handle: unknown) => void
	setInterval?: (cb: () => void, ms: number) => unknown
	clearInterval?: (handle: unknown) => void
	/** Injectable clock for latency measurement. Default `Date.now`. */
	now?: () => number
}

/** Default health-ping cadence while a node is connected. */
export const DEFAULT_PING_INTERVAL_MS = 15_000
/** Default first-retry delay; doubles per attempt up to the shared backoff ceiling. */
export const DEFAULT_RECONNECT_BASE_MS = 1_000
/** Default number of reconnect attempts before giving up to `error`. */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 6

type ProbeResult =
	| { kind: "ok" }
	| { kind: "unauthorized"; error: string }
	| { kind: "version-mismatch"; error: string }
	| { kind: "error"; error: string }

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e)
}

/**
 * Best-effort {@link LoadSample} extraction from a `/health` (or `/whoami`) JSON
 * body. Returns `undefined` unless a well-formed `loadavg` triple + numeric
 * `cpus` are present, so a node that doesn't report metrics simply has no sample.
 */
function parseLoadSample(body: unknown): LoadSample | undefined {
	if (typeof body !== "object" || body === null) return undefined
	const { loadavg, cpus } = body as { loadavg?: unknown; cpus?: unknown }
	if (!Array.isArray(loadavg) || loadavg.length < 3) return undefined
	if (!loadavg.slice(0, 3).every((n) => typeof n === "number" && Number.isFinite(n))) return undefined
	if (typeof cpus !== "number" || !Number.isFinite(cpus)) return undefined
	return { loadavg: [loadavg[0], loadavg[1], loadavg[2]] as [number, number, number], cpus }
}

export class NodeConnection {
	private _status: ShoferNodeConnState = "disconnected"
	private _latencyMs?: number
	private _agentVersion?: string
	private _error?: string
	private _load?: LoadSample
	private _configVersion?: string
	private _managed?: boolean
	private _client?: ShoferHttpClient

	private readonly emitter = new TypedEmitter<ShoferNodeConnState>()
	private pingHandle?: unknown
	private reconnectHandle?: unknown
	private reconnectAttempt = 0
	private disposed = false

	constructor(private readonly opts: NodeConnectionOptions) {}

	get status(): ShoferNodeConnState {
		return this._status
	}
	get latencyMs(): number | undefined {
		return this._latencyMs
	}
	get agentVersion(): string | undefined {
		return this._agentVersion
	}
	get error(): string | undefined {
		return this._error
	}
	/**
	 * The remote node's latest {@link LoadSample} (from the `GET /health` ping /
	 * initial handshake), or `undefined` if the node hasn't reported one yet. Fed
	 * into the controller's ExecutorPool for its load-average LB policy.
	 */
	get load(): LoadSample | undefined {
		return this._load
	}
	/**
	 * The node's last-applied config-sync version (config_sync §6), echoed on the
	 * `whoami` handshake and every `GET /health` ping. The controller's ExecutorPool
	 * gates pool eligibility on `configVersion === desiredVersion` (drift detection);
	 * `undefined` until the node reports one.
	 */
	get configVersion(): string | undefined {
		return this._configVersion
	}
	/**
	 * Whether this node accepts controller config (config_sync §Part A). A node that
	 * reports `managed: false` is self-administered (started with local CLI overrides):
	 * it ignores config pushes and serves tasks on its own config, so the controller's
	 * ExecutorPool EXEMPTS it from config-version gating. Defaults to `true` (gated —
	 * the safe direction: a managed node that hasn't reported yet must not skip the gate).
	 */
	get managed(): boolean {
		return this._managed ?? true
	}
	/** The live agent surface — only exposed while `connected`. */
	get api(): AgentApi | undefined {
		return this._status === "connected" ? this._client : undefined
	}

	/**
	 * Mark this node as having applied `version` (config_sync §Part A). The controller
	 * calls this right after a successful `applyConfig` push so a just-synced node
	 * becomes pool-assignable immediately, without waiting for the next `/health` tick;
	 * the health echo remains the ongoing source of truth (it overwrites this on ping).
	 */
	markConfigApplied(version: string): void {
		this._configVersion = version
	}

	/** Subscribe to status changes (also fired on latency updates). Returns an unsubscribe. */
	onStatusChange(cb: (state: ShoferNodeConnState) => void): () => void {
		const sub = this.emitter.event(cb)
		return () => sub.dispose()
	}

	/** Begin (or restart) the connection handshake. */
	async connect(): Promise<void> {
		this.disposed = false
		this.clearReconnect()
		this.stopPing()
		this.reconnectAttempt = 0
		this.setStatus("connecting")
		const result = await this.probe()
		if (this.disposed) return
		this.applyProbe(result, false)
	}

	/** Tear the connection down; state → `disconnected`. */
	disconnect(): void {
		this.disposed = true
		this.stopPing()
		this.clearReconnect()
		this.teardownClient()
		this.reconnectAttempt = 0
		this._latencyMs = undefined
		this._load = undefined
		this._configVersion = undefined
		this._managed = undefined
		this.setStatus("disconnected")
	}

	/** Full teardown incl. the status emitter (call when discarding the connection). */
	dispose(): void {
		this.disconnect()
		this.emitter.dispose()
	}

	// ── handshake ────────────────────────────────────────────────────────────

	private get apiBase(): string {
		return `${this.opts.baseUrl.replace(/\/$/, "")}/api/v1`
	}
	private get healthUrl(): string {
		return `${this.opts.baseUrl.replace(/\/$/, "")}/health`
	}
	private authHeaders(): Record<string, string> {
		return this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}
	}
	private get doFetch(): typeof fetch {
		return this.opts.fetch ?? fetch
	}

	private async probe(): Promise<ProbeResult> {
		let res: Response
		try {
			res = await this.doFetch(`${this.apiBase}/whoami`, { headers: this.authHeaders() })
		} catch (e) {
			return { kind: "error", error: errMsg(e) }
		}
		if (res.status === 401) return { kind: "unauthorized", error: "authentication failed (401)" }
		if (!res.ok) return { kind: "error", error: `whoami → ${res.status}` }

		let version: string | undefined
		try {
			const body = (await res.json()) as { version?: string }
			version = body.version
			// Accept load metrics from the handshake too, if the node volunteers them.
			const sample = parseLoadSample(body)
			if (sample) this._load = sample
			const cv = (body as { configVersion?: unknown }).configVersion
			if (typeof cv === "string") this._configVersion = cv
			const mg = (body as { managed?: unknown }).managed
			if (typeof mg === "boolean") this._managed = mg
		} catch {
			version = undefined
		}
		this._agentVersion = version
		if (version !== this.opts.controllerVersion) {
			return {
				kind: "version-mismatch",
				error: `node v${version ?? "?"} ≠ controller v${this.opts.controllerVersion}`,
			}
		}
		return { kind: "ok" }
	}

	private applyProbe(result: ProbeResult, fromReconnect: boolean): void {
		switch (result.kind) {
			case "ok":
				this._client = new ShoferHttpClient({
					baseUrl: this.opts.baseUrl,
					token: this.opts.token,
					fetch: this.opts.fetch,
				})
				this._error = undefined
				this.reconnectAttempt = 0
				this.setStatus("connected")
				this.startPing()
				return
			case "unauthorized":
				this.teardownClient()
				this.setStatus("unauthorized", result.error)
				return
			case "version-mismatch":
				this.teardownClient()
				this.setStatus("version-mismatch", result.error)
				return
			case "error":
				this.teardownClient()
				if (fromReconnect) this.scheduleReconnect(result.error)
				else this.setStatus("error", result.error)
				return
		}
	}

	// ── health ping ──────────────────────────────────────────────────────────

	private startPing(): void {
		this.stopPing()
		const interval = this.opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS
		const setIntervalFn = this.opts.setInterval ?? ((cb, ms) => setInterval(cb, ms))
		this.pingHandle = setIntervalFn(() => {
			void this.ping()
		}, interval)
	}

	private stopPing(): void {
		if (this.pingHandle === undefined) return
		const clearIntervalFn = this.opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>))
		clearIntervalFn(this.pingHandle)
		this.pingHandle = undefined
	}

	private async ping(): Promise<void> {
		if (this.disposed || this._status !== "connected") return
		const now = this.opts.now ?? Date.now
		const start = now()
		let res: Response
		try {
			res = await this.doFetch(this.healthUrl, {})
		} catch (e) {
			return this.onPingFailure(errMsg(e))
		}
		if (!res.ok) return this.onPingFailure(`health → ${res.status}`)
		this._latencyMs = Math.max(0, Math.round(now() - start))
		try {
			const body = await res.json()
			const sample = parseLoadSample(body)
			if (sample) this._load = sample
			const cv = (body as { configVersion?: unknown }).configVersion
			if (typeof cv === "string") this._configVersion = cv
			const mg = (body as { managed?: unknown }).managed
			if (typeof mg === "boolean") this._managed = mg
		} catch {
			// Non-JSON / malformed health body — keep the previous sample.
		}
		this.reconnectAttempt = 0
		// Re-fire the (unchanged) status so subscribers pick up the new latency.
		this.emitter.fire(this._status)
	}

	private onPingFailure(error: string): void {
		this.stopPing()
		this.teardownClient()
		this.setStatus("reconnecting", error)
		this.scheduleReconnect(error)
	}

	// ── reconnect backoff ──────────────────────────────────────────────────────

	private scheduleReconnect(error: string): void {
		if (this.disposed) return
		const max = this.opts.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS
		if (this.reconnectAttempt >= max) {
			this.teardownClient()
			this.setStatus("error", `giving up after ${this.reconnectAttempt} reconnect attempts (${error})`)
			return
		}
		this.reconnectAttempt++
		this.setStatus("reconnecting", error)
		const setTimeoutFn = this.opts.setTimeout ?? ((cb, ms) => setTimeout(cb, ms))
		this.reconnectHandle = setTimeoutFn(() => {
			void this.reconnectNow()
		}, this.backoffMs(this.reconnectAttempt))
	}

	private async reconnectNow(): Promise<void> {
		this.reconnectHandle = undefined
		if (this.disposed) return
		const result = await this.probe()
		if (this.disposed) return
		this.applyProbe(result, true)
	}

	private backoffMs(attempt: number): number {
		const base = this.opts.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS
		const capMs = MAX_EXPONENTIAL_BACKOFF_SECONDS * 1000
		return Math.min(base * 2 ** (attempt - 1), capMs)
	}

	private clearReconnect(): void {
		if (this.reconnectHandle === undefined) return
		const clearTimeoutFn = this.opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
		clearTimeoutFn(this.reconnectHandle)
		this.reconnectHandle = undefined
	}

	// ── helpers ────────────────────────────────────────────────────────────────

	private teardownClient(): void {
		this._client = undefined
	}

	private setStatus(status: ShoferNodeConnState, error?: string): void {
		this._status = status
		this._error = error
		this.emitter.fire(status)
	}
}
