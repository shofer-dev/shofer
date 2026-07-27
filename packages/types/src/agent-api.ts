/**
 * The transport-agnostic agent surface (v3 architecture §11).
 *
 * `AgentApi` is the minimal control plane a front-end/transport drives: create a
 * task, send follow-up messages, cancel, and subscribe to the event stream. Every
 * transport (HTTP/SSE, ACP over stdio, the controller↔executor session protocol)
 * is implemented over this one interface, and the live in-process implementation
 * (`ShoferApiAgent`) backs it with the extension's `ShoferAPI`.
 *
 * Lives in `@shofer/types` (vscode-free) so both the core-side implementations and
 * the wire-protocol modules (`session-transport.ts`) can share it.
 */

import type { SyncedSecrets, SyncedSettings } from "./global-settings.js"
import type { ProviderSettings } from "./provider-settings.js"

/** A streamed agent event. `type` is the event name; other fields are event-specific. */
export interface ServerEvent {
	type: string
	[key: string]: unknown
}

/**
 * Parameters for {@link AgentApi.createTask}.
 *
 * `mode` is **required**: every task runs in a specific mode (its slug, e.g.
 * `"code"`), so the controller must always state which one. It is applied
 * per-task (via `CreateTaskOptions.initialMode`), so concurrent tasks on the same
 * executor can run in different modes without a global mode switch. Unlike
 * `apiConfiguration`, `mode` is honoured even when the node has local CLI
 * overrides — it selects behaviour, not provider credentials.
 *
 * `apiConfiguration` carries the controller's per-task API Configuration (the
 * resolved {@link ProviderSettings}: provider, model, base URL, key, …) to the
 * executor. A remote node applies it so the task runs on the SAME provider the
 * VS Code front-end picked (and it can differ per task) — UNLESS the node was
 * launched with explicit CLI overrides (`--provider`/`--model`/`--api-key`/
 * `--base-url`), in which case the node's own config wins and this is ignored.
 * Omitted for local/in-process tasks (they read the provider's live config).
 */
export interface CreateTaskInput {
	prompt: string
	mode: string
	taskId?: string
	apiConfiguration?: ProviderSettings
}

/** A reply to an outstanding `ask` (interactive tool approval / follow-up). */
export interface AskResponse {
	/** The ask-response verb (e.g. `yesButtonClicked`, `noButtonClicked`, `messageResponse`). */
	askResponse: string
	/** Optional free-text the user typed alongside the response. */
	text?: string
	/** Optional image data URIs attached to the response. */
	images?: string[]
	/** The id of the ask being answered (routes to the correct outstanding ask). */
	askId?: string
	/**
	 * Optional mode slug to switch the task to as part of this answer. Mirrors the
	 * webview picking an `ask_followup_question` suggestion that carries a `mode`:
	 * the mode switch is applied to this task before the answer is resolved. Ignored
	 * when absent.
	 */
	mode?: string
}

/** The agent control plane a transport drives. */
export interface AgentApi {
	createTask(input: CreateTaskInput): Promise<{ taskId: string }>
	sendMessage(taskId: string, message: string): Promise<void>
	cancelTask(taskId: string): Promise<void>
	/**
	 * Answer a task's outstanding `ask` (interactive tool approval / follow-up).
	 * This is the reverse of the `ask` events streamed via {@link subscribe}: the
	 * front-end drives an approval back to the owning executor, so a remote task's
	 * approvals round-trip exactly like a local task's.
	 */
	respondToAsk(taskId: string, response: AskResponse): Promise<void>

	/** Node-scoped settings + secrets the controller replicates to this executor (config_sync §4a).
	 *  `version` is the controller-assigned, node-opaque token the node stores and echoes
	 *  on /health so the controller detects drift. `secrets` is the allow-listed credential
	 *  slice (`SYNCED_SECRET_KEYS`) the node needs to act on `config` — pass `{}` when there
	 *  is nothing to replicate. Both are ignored when the node has local CLI overrides
	 *  (allowClientConfig === false), same rule as apiConfiguration. */
	applyConfig(config: SyncedSettings, version: string, secrets: SyncedSecrets): Promise<void>

	// ── Reverse data channel (Shofer Nodes L3) ──────────────────────────────────
	// A plugin-owned per-task feature for a REMOTE (shadow) task: the controller reads
	// and mutates it on the owning executor over the control plane, exactly like a local
	// task drives its own in-process plugin. One generic method carries all of them —
	// the file-changes panel, checkpoints, anything a plugin ships — so adding a feature
	// never means adding a wire method.

	/**
	 * Call a plugin running on the task's host and return its result — the generic
	 * request/response channel for a FEATURE that lives in a plugin (`ShoferPlugin.handleRequest`).
	 *
	 * Per-task plugin state (a workspace snapshot, an external job) lives wherever the
	 * task runs, so a controller rendering a REMOTE task cannot reach it in-process. This
	 * routes the call to the owning host, keeping the transport generic: a new
	 * plugin-owned feature needs no new wire method.
	 *
	 * `params`/result are plugin-defined JSON. Errors propagate to the caller — a
	 * request has someone waiting on the answer.
	 */
	pluginRequest(taskId: string, plugin: string, method: string, params?: unknown): Promise<unknown>

	/** Subscribe to the agent event stream; returns an unsubscribe fn. */
	subscribe(listener: (event: ServerEvent) => void): () => void
}
