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

import type { CheckpointDiffEntry, CheckpointDiffOptions, CheckpointRestoreOptions } from "./checkpoints.js"
import type { SyncedSecrets, SyncedSettings } from "./global-settings.js"
import type { ProviderSettings } from "./provider-settings.js"
import type { ChangedFilesPayload } from "./vscode-extension-host.js"

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
	// Checkpoint diff/restore + the changed-files panel for a REMOTE (shadow) task:
	// the controller fetches data / executes ops on the owning executor over the
	// control plane, exactly like a local task drives its own in-process service.
	// Data methods return a payload; execute methods run an op and resolve.

	/**
	 * Compute a checkpoint diff on the executor and ship the per-file changes back.
	 * The executor resolves from/to hashes and runs `service.getDiff` (skipping
	 * binary/oversized files to bound the payload); the controller renders them via
	 * `showMultiFileDiff` and resolves the title locally.
	 */
	getCheckpointDiff(taskId: string, opts: CheckpointDiffOptions): Promise<CheckpointDiffEntry[]>
	/** The task's changed-files panel payload (files the executor's task edited). */
	getTaskChangedFiles(taskId: string): Promise<ChangedFilesPayload>
	/** The original (base) + final content for one changed file, for the diff editor. */
	getChangedFileDiff(taskId: string, relPath: string): Promise<{ original: string | null; final: string | null }>
	/** Restore the task to a checkpoint on the executor (rewinds the executor's task). */
	restoreCheckpoint(taskId: string, opts: CheckpointRestoreOptions): Promise<void>
	/** Revert one changed file to its base state on the executor. */
	revertChangedFile(taskId: string, relPath: string): Promise<void>
	/** Revert every changed file for the task on the executor. */
	revertAllChangedFiles(taskId: string): Promise<void>
	/** Accept one changed file (promote its current state to the new baseline). */
	acceptChangedFile(taskId: string, relPath: string): Promise<void>
	/** Accept every changed file for the task on the executor. */
	acceptAllChangedFiles(taskId: string): Promise<void>

	/** Subscribe to the agent event stream; returns an unsubscribe fn. */
	subscribe(listener: (event: ServerEvent) => void): () => void
}
