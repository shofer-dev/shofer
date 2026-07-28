/**
 * Shofer Nodes — the unified "where does the agent run" concept.
 *
 * A *node* is an executor that runs `extension.js`. The built-in **Local** node
 * is today's in-extension-host agent (non-removable, the default). **Remote**
 * nodes run the same bundle elsewhere (`shofer serve`) and are driven over the
 * HTTP/SSE control plane (`AgentApi`; see `transport/http-client.ts`, `docs/agentapi.md`).
 * These types are the contract
 * between the webview UI (Settings → Shofer Nodes, the Nodes header button) and
 * the extension. Design: `docs/v3_architecture.md` §Distributed execution;
 * platform-declared nodes: `docs/configuration.md` §`nodes.json`.
 *
 * Secrets never live here: the per-node connection token is kept in VS Code
 * SecretStorage and only its *presence* (`hasToken`) is surfaced to the webview.
 */

import type { LoadBalancerPolicy } from "./executor-pool.js"

export type ShoferNodeKind = "local" | "remote"

/**
 * Live connection state of a node.
 * - `running` — the Local node (always available; no transport).
 * - `version-mismatch` — node's shofer version differs from the controller's;
 *   connecting is refused (hard requirement — controller and node must match).
 */
export type ShoferNodeConnState =
	| "running"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "disconnected"
	| "unauthorized"
	| "version-mismatch"
	| "error"

/** Persisted, non-secret node definition (stored per-workspace). */
export interface ShoferNodeDef {
	id: string
	kind: ShoferNodeKind
	/** Friendly name shown in the header Nodes list. */
	label: string
	/** Remote only: `IP:port` or DNS host, composed into `http(s)://<host>/api/v1`. */
	host?: string
	/** Remote only: use `https` (TLS) instead of `http`. */
	tls?: boolean
	/**
	 * Reconnect this node automatically on extension/VS Code start. Set when the
	 * user connects to it, cleared when they disconnect.
	 */
	autoConnect?: boolean
	/**
	 * Administratively disabled — taken out of the pool. A disabled node cannot be
	 * connected or used for tasks (applies to Local too) until re-enabled.
	 */
	disabled?: boolean
	/**
	 * This node came from a `.shofer/nodes.json` declaration rather than from the UI
	 * (docs/workspace_agent_pool.md §4). The declaration is its source of truth: it is
	 * re-applied on every reconcile and disappears when the file stops declaring it, so
	 * the UI offers no delete — only disable, which is a runtime flag the reconcile
	 * preserves.
	 */
	declared?: boolean
	/**
	 * Absolute path to the file holding this node's bearer token (declared nodes; a
	 * projected Kubernetes Secret, typically). Read at connect time so rotating the
	 * secret needs no declaration change. Never carries the token itself.
	 */
	tokenFile?: string
}

/** A node definition plus its live status — pushed to the webview (no secrets). */
export interface ShoferNodeView extends ShoferNodeDef {
	status: ShoferNodeConnState
	/** Last ping round-trip in ms (remote, when connected). */
	latencyMs?: number
	/** Node's reported shofer/agent version (must equal the controller's). */
	agentVersion?: string
	/** Last error detail, if status is `error`/`unauthorized`/`version-mismatch`. */
	error?: string
	/** Whether the active task is currently running on this node. */
	isActive: boolean
	/** Administratively disabled (out of the pool). Resolved for Local too. */
	disabled: boolean
	/** Remote only: whether a connection token is stored in SecretStorage. */
	hasToken?: boolean
}

/** Full nodes snapshot the extension pushes to the webview. */
export interface ShoferNodesState {
	nodes: ShoferNodeView[]
	activeNodeId: string
	/** The pool's current new-task load-balancing policy (drives the panel dropdown). */
	loadBalancer: LoadBalancerPolicy
}

/** Webview → extension request (carried in `WebviewMessage.shoferNode`). */
export type ShoferNodeRequest =
	/** Ask the extension to (re)push the current {@link ShoferNodesState}. */
	| { action: "list" }
	/**
	 * Create or update a node. `token`, when present, is stored in SecretStorage
	 * and never echoed back. Omit `token` to leave an existing one untouched.
	 */
	| { action: "upsert"; node: ShoferNodeDef; token?: string }
	| { action: "remove"; id: string }
	| { action: "connect"; id: string }
	| { action: "disconnect"; id: string }
	/** Administratively enable/disable a node (applies to Local too). */
	| { action: "setDisabled"; id: string; disabled: boolean }
	/** Select the pool's new-task load-balancing policy (persisted + applied live). */
	| { action: "setLoadBalancer"; policy: LoadBalancerPolicy }

/** The reserved id of the built-in Local node. */
export const LOCAL_NODE_ID = "local"
