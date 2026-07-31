/**
 * Shofer Workers — the unified "where does the agent run" concept.
 *
 * A *worker* is an executor that runs `extension.js`. The built-in **Local** worker
 * is today's in-extension-host agent (non-removable, the default). **Remote**
 * workers run the same bundle elsewhere (`shofer serve`) and are driven over the
 * HTTP/SSE control plane (`AgentApi`; see `transport/http-client.ts`, `docs/agentapi.md`).
 * These types are the contract
 * between the webview UI (Settings → Shofer Workers, the Workers header button) and
 * the extension. Design: `docs/v3_architecture.md` §Distributed execution;
 * platform-declared workers: `docs/configuration.md` §`workers.json`.
 *
 * Secrets never live here: the per-worker connection token is kept in VS Code
 * SecretStorage and only its *presence* (`hasToken`) is surfaced to the webview.
 */

import type { LoadBalancerPolicy } from "./worker-pool.js"

export type ShoferWorkerKind = "local" | "remote"

/**
 * Live connection state of a worker.
 * - `running` — the Local worker (always available; no transport).
 * - `version-mismatch` — worker's shofer version differs from the controller's;
 *   connecting is refused (hard requirement — controller and worker must match).
 */
export type ShoferWorkerConnState =
	| "running"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "disconnected"
	| "unauthorized"
	| "version-mismatch"
	| "error"

/** Persisted, non-secret worker definition (stored per-workspace). */
export interface ShoferWorkerDef {
	id: string
	kind: ShoferWorkerKind
	/** Friendly name shown in the header Workers list. */
	label: string
	/** Remote only: `IP:port` or DNS host, composed into `http(s)://<host>/api/v1`. */
	host?: string
	/** Remote only: use `https` (TLS) instead of `http`. */
	tls?: boolean
	/**
	 * Reconnect this worker automatically on extension/VS Code start. Set when the
	 * user connects to it, cleared when they disconnect.
	 */
	autoConnect?: boolean
	/**
	 * Administratively disabled — taken out of the pool. A disabled worker cannot be
	 * connected or used for tasks (applies to Local too) until re-enabled.
	 */
	disabled?: boolean
	/**
	 * This worker came from a `.shofer/workers.json` declaration rather than from the UI
	 * (docs/workspace_agent_pool.md §4). The declaration is its source of truth: it is
	 * re-applied on every reconcile and disappears when the file stops declaring it, so
	 * the UI offers no delete — only disable, which is a runtime flag the reconcile
	 * preserves.
	 */
	declared?: boolean
	/**
	 * Absolute path to the file holding this worker's bearer token (declared workers; a
	 * projected Kubernetes Secret, typically). Read at connect time so rotating the
	 * secret needs no declaration change. Never carries the token itself.
	 */
	tokenFile?: string
	/**
	 * Name of an environment variable holding this worker's bearer token — the same
	 * indirection as {@link tokenFile}, for the k8s shape where a `secretKeyRef`
	 * delivers the value as env. `tokenFile` wins when both are set.
	 */
	tokenEnv?: string
}

/** A worker definition plus its live status — pushed to the webview (no secrets). */
export interface ShoferWorkerView extends ShoferWorkerDef {
	status: ShoferWorkerConnState
	/** Last ping round-trip in ms (remote, when connected). */
	latencyMs?: number
	/** Worker's reported shofer/agent version (must equal the controller's). */
	agentVersion?: string
	/** Last error detail, if status is `error`/`unauthorized`/`version-mismatch`. */
	error?: string
	/** Whether the active task is currently running on this worker. */
	isActive: boolean
	/** Administratively disabled (out of the pool). Resolved for Local too. */
	disabled: boolean
	/** Remote only: whether a connection token is stored in SecretStorage. */
	hasToken?: boolean
}

/** Full workers snapshot the extension pushes to the webview. */
export interface ShoferWorkersState {
	workers: ShoferWorkerView[]
	activeWorkerId: string
	/** The pool's current new-task load-balancing policy (drives the panel dropdown). */
	loadBalancer: LoadBalancerPolicy
}

/** Webview → extension request (carried in `WebviewMessage.shoferWorker`). */
export type ShoferWorkerRequest =
	/** Ask the extension to (re)push the current {@link ShoferWorkersState}. */
	| { action: "list" }
	/**
	 * Create or update a worker. `token`, when present, is stored in SecretStorage
	 * and never echoed back. Omit `token` to leave an existing one untouched.
	 */
	| { action: "upsert"; worker: ShoferWorkerDef; token?: string }
	| { action: "remove"; id: string }
	| { action: "connect"; id: string }
	| { action: "disconnect"; id: string }
	/** Administratively enable/disable a worker (applies to Local too). */
	| { action: "setDisabled"; id: string; disabled: boolean }
	/** Select the pool's new-task load-balancing policy (persisted + applied live). */
	| { action: "setLoadBalancer"; policy: LoadBalancerPolicy }

/** The reserved id of the built-in Local worker. */
export const LOCAL_WORKER_ID = "local"
