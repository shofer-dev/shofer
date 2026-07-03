/**
 * Shofer Nodes — the unified "where does the agent run" concept.
 *
 * A *node* is an executor that runs `extension.js`. The built-in **Local** node
 * is today's in-extension-host agent (non-removable, the default). **Remote**
 * nodes run the same bundle elsewhere and are driven over the remote-agent
 * WebSocket protocol (see `./remote-agent.ts`). These types are the contract
 * between the webview UI (Settings → Shofer Nodes, the Nodes header button) and
 * the extension. Design: `docs/remote-agents.md` (§4, §4b).
 *
 * Secrets never live here: the per-node connection token is kept in VS Code
 * SecretStorage and only its *presence* (`hasToken`) is surfaced to the webview.
 */

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
	/** Remote only: `IP:port` or DNS host, composed into `ws(s)://<host>/agent/:ws`. */
	host?: string
	/** Remote only: use `wss` (TLS) instead of `ws`. */
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
	 * Remote only: which headless-compatible LLM provider the node uses
	 * (`llm-router` by default, or a direct upstream). The VS Code LM provider
	 * can't run remotely. See `docs/remote-agents.md` §6b.
	 */
	remoteProvider?: string
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

/**
 * A remote-owned task that raised an `ask` which the controller CANNOT answer
 * (interactive remote approvals are L3). Surfaced so the webview shows a visible
 * "cannot respond to remote ask" notice instead of hanging on dead buttons.
 */
export interface BlockedRemoteAsk {
	nodeId: string
	nodeLabel: string
	/** The ask prompt text, when the remote provided one. */
	text?: string
}

/** Full nodes snapshot the extension pushes to the webview. */
export interface ShoferNodesState {
	nodes: ShoferNodeView[]
	activeNodeId: string
	/**
	 * Set when the focused remote task is blocked on a non-auto-approved ask. The
	 * webview renders a notice; the controller never silently hangs.
	 */
	blockedRemoteAsk?: BlockedRemoteAsk
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

/** The reserved id of the built-in Local node. */
export const LOCAL_NODE_ID = "local"
