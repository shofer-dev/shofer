import type { AgentApi, AskResponse, ServerEvent } from "./agent-api.js"
import type { CheckpointDiffEntry, CheckpointDiffOptions, CheckpointRestoreOptions } from "./checkpoints.js"
import type { SyncedSecrets, SyncedSettings } from "./global-settings.js"
import type { HostBridge } from "./host.js"
import type { ChangedFilesPayload } from "./vscode-extension-host.js"
import { type HostRpcChannel, type RemoteHostCapability, dispatchHostCall } from "./host-rpc.js"

/**
 * Controller ↔ executor session transport (v3 architecture §12–§13).
 *
 * One protocol carries both directions of a distributed agent session:
 *  - **Agent channel** (controller → executor): drive the {@link AgentApi}
 *    (createTask/sendMessage/cancelTask) and receive the streamed event feed.
 *  - **Host-callback channel** (executor → controller): the front-end-bound slice
 *    of Category I ({@link HostRpcChannel}) — a remote executor RPCs
 *    notifier/lsp/workspace back to the controller that owns the UI.
 *
 * Both endpoints are transport-agnostic: constructed with a `send(frame)` sink and
 * fed inbound frames via `receive(frame)`. A concrete transport (WebSocket, stdio,
 * the ACP `session/*` methods) just serializes the frames. This module is the pure
 * plumbing that ties §11 (AgentApi), §12 (transports), and §13 (split host) together.
 */

/** Controller → executor. */
export type SessionClientFrame =
	| { t: "cmd"; id: number; method: "createTask"; input: { prompt: string; mode: string; taskId?: string } }
	| { t: "cmd"; id: number; method: "sendMessage"; taskId: string; message: string }
	| { t: "cmd"; id: number; method: "cancelTask"; taskId: string }
	| { t: "cmd"; id: number; method: "respondToAsk"; taskId: string; response: AskResponse }
	// Node-scoped config replication (config_sync §4a). `secrets` carries the
	// allow-listed credential slice alongside the settings slice.
	| { t: "cmd"; id: number; method: "applyConfig"; config: SyncedSettings; version: string; secrets: SyncedSecrets }
	// Reverse data channel (Shofer Nodes L3): checkpoint diff/restore + changed-files.
	| { t: "cmd"; id: number; method: "getCheckpointDiff"; taskId: string; opts: CheckpointDiffOptions }
	| { t: "cmd"; id: number; method: "getTaskChangedFiles"; taskId: string }
	| { t: "cmd"; id: number; method: "getChangedFileDiff"; taskId: string; relPath: string }
	| { t: "cmd"; id: number; method: "restoreCheckpoint"; taskId: string; opts: CheckpointRestoreOptions }
	| { t: "cmd"; id: number; method: "revertChangedFile"; taskId: string; relPath: string }
	| { t: "cmd"; id: number; method: "revertAllChangedFiles"; taskId: string }
	| { t: "cmd"; id: number; method: "acceptChangedFile"; taskId: string; relPath: string }
	| { t: "cmd"; id: number; method: "acceptAllChangedFiles"; taskId: string }
	// Generic plugin RPC: reach a plugin-owned feature on the task's own host.
	| {
			t: "cmd"
			id: number
			method: "pluginRequest"
			taskId: string
			plugin: string
			pluginMethod: string
			params?: unknown
	  }
	/** Reply to a host-callback request. */
	| { t: "hostResult"; id: number; result?: unknown; error?: string }

/** Executor → controller. */
export type SessionServerFrame =
	/** Reply to a client command. */
	| { t: "result"; id: number; result?: unknown; error?: string }
	/** A streamed agent event. */
	| { t: "event"; event: ServerEvent }
	/** A host-callback request (Category I over RPC). */
	| { t: "hostCall"; id: number; capability: RemoteHostCapability; method: string; params: unknown[] }

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ---------------------------------------------------------------------------
// Executor endpoint
// ---------------------------------------------------------------------------

export interface ExecutorEndpoint {
	/** Feed an inbound frame from the controller. */
	receive(frame: SessionClientFrame): Promise<void>
	/** The host-callback channel; pass to `createSplitHost({ local, channel })`. */
	channel: HostRpcChannel
	/** Stop streaming events. */
	dispose(): void
}

/**
 * The executor side: serves the {@link AgentApi} over the link, streams its events,
 * and exposes an {@link HostRpcChannel} that reaches the controller's host.
 */
export function serveSession({
	api,
	send,
}: {
	api: AgentApi
	send: (frame: SessionServerFrame) => void
}): ExecutorEndpoint {
	let hostSeq = 0
	const pendingHostCalls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
	const unsubscribe = api.subscribe((event) => send({ t: "event", event }))

	const channel: HostRpcChannel = {
		invoke: (capability, method, params) =>
			new Promise<unknown>((resolve, reject) => {
				const id = ++hostSeq
				pendingHostCalls.set(id, { resolve, reject })
				send({ t: "hostCall", id, capability, method, params })
			}),
	}

	async function receive(frame: SessionClientFrame): Promise<void> {
		if (frame.t === "hostResult") {
			const pend = pendingHostCalls.get(frame.id)
			if (!pend) return
			pendingHostCalls.delete(frame.id)
			if (frame.error) pend.reject(new Error(frame.error))
			else pend.resolve(frame.result)
			return
		}
		try {
			let result: unknown = null
			if (frame.method === "createTask") result = await api.createTask(frame.input)
			else if (frame.method === "sendMessage") await api.sendMessage(frame.taskId, frame.message)
			else if (frame.method === "cancelTask") await api.cancelTask(frame.taskId)
			else if (frame.method === "respondToAsk") await api.respondToAsk(frame.taskId, frame.response)
			else if (frame.method === "applyConfig") await api.applyConfig(frame.config, frame.version, frame.secrets)
			else if (frame.method === "getCheckpointDiff")
				result = await api.getCheckpointDiff(frame.taskId, frame.opts)
			else if (frame.method === "getTaskChangedFiles") result = await api.getTaskChangedFiles(frame.taskId)
			else if (frame.method === "getChangedFileDiff")
				result = await api.getChangedFileDiff(frame.taskId, frame.relPath)
			else if (frame.method === "restoreCheckpoint") await api.restoreCheckpoint(frame.taskId, frame.opts)
			else if (frame.method === "revertChangedFile") await api.revertChangedFile(frame.taskId, frame.relPath)
			else if (frame.method === "revertAllChangedFiles") await api.revertAllChangedFiles(frame.taskId)
			else if (frame.method === "acceptChangedFile") await api.acceptChangedFile(frame.taskId, frame.relPath)
			else if (frame.method === "acceptAllChangedFiles") await api.acceptAllChangedFiles(frame.taskId)
			else if (frame.method === "pluginRequest")
				result = await api.pluginRequest(frame.taskId, frame.plugin, frame.pluginMethod, frame.params)
			send({ t: "result", id: frame.id, result })
		} catch (e) {
			send({ t: "result", id: frame.id, error: errMsg(e) })
		}
	}

	return { receive, channel, dispose: unsubscribe }
}

// ---------------------------------------------------------------------------
// Controller endpoint
// ---------------------------------------------------------------------------

export interface ControllerEndpoint {
	/** An {@link AgentApi} that drives the remote executor over the link. */
	api: AgentApi
	/** Feed an inbound frame from the executor. */
	receive(frame: SessionServerFrame): Promise<void>
}

/**
 * The controller side: exposes an {@link AgentApi} that proxies to the remote
 * executor, forwards the executor's events to subscribers, and serves the
 * executor's host-callbacks against the controller's real `host`.
 */
export function connectSession({
	host,
	send,
}: {
	host: HostBridge
	send: (frame: SessionClientFrame) => void
}): ControllerEndpoint {
	let cmdSeq = 0
	const pendingCmds = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
	const listeners = new Set<(event: ServerEvent) => void>()

	const command = (build: (id: number) => SessionClientFrame): Promise<unknown> =>
		new Promise<unknown>((resolve, reject) => {
			const id = ++cmdSeq
			pendingCmds.set(id, { resolve, reject })
			send(build(id))
		})

	const api: AgentApi = {
		createTask: (input) =>
			command((id) => ({ t: "cmd", id, method: "createTask", input })) as Promise<{ taskId: string }>,
		sendMessage: async (taskId, message) => {
			await command((id) => ({ t: "cmd", id, method: "sendMessage", taskId, message }))
		},
		cancelTask: async (taskId) => {
			await command((id) => ({ t: "cmd", id, method: "cancelTask", taskId }))
		},
		respondToAsk: async (taskId, response) => {
			await command((id) => ({ t: "cmd", id, method: "respondToAsk", taskId, response }))
		},
		applyConfig: async (config, version, secrets) => {
			await command((id) => ({ t: "cmd", id, method: "applyConfig", config, version, secrets }))
		},
		getCheckpointDiff: (taskId, opts) =>
			command((id) => ({ t: "cmd", id, method: "getCheckpointDiff", taskId, opts })) as Promise<
				CheckpointDiffEntry[]
			>,
		getTaskChangedFiles: (taskId) =>
			command((id) => ({ t: "cmd", id, method: "getTaskChangedFiles", taskId })) as Promise<ChangedFilesPayload>,
		getChangedFileDiff: (taskId, relPath) =>
			command((id) => ({ t: "cmd", id, method: "getChangedFileDiff", taskId, relPath })) as Promise<{
				original: string | null
				final: string | null
			}>,
		restoreCheckpoint: async (taskId, opts) => {
			await command((id) => ({ t: "cmd", id, method: "restoreCheckpoint", taskId, opts }))
		},
		revertChangedFile: async (taskId, relPath) => {
			await command((id) => ({ t: "cmd", id, method: "revertChangedFile", taskId, relPath }))
		},
		revertAllChangedFiles: async (taskId) => {
			await command((id) => ({ t: "cmd", id, method: "revertAllChangedFiles", taskId }))
		},
		acceptChangedFile: async (taskId, relPath) => {
			await command((id) => ({ t: "cmd", id, method: "acceptChangedFile", taskId, relPath }))
		},
		acceptAllChangedFiles: async (taskId) => {
			await command((id) => ({ t: "cmd", id, method: "acceptAllChangedFiles", taskId }))
		},
		pluginRequest: (taskId, plugin, method, params) =>
			command((id) => ({ t: "cmd", id, method: "pluginRequest", taskId, plugin, pluginMethod: method, params })),
		subscribe: (listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	}

	async function receive(frame: SessionServerFrame): Promise<void> {
		if (frame.t === "result") {
			const pend = pendingCmds.get(frame.id)
			if (!pend) return
			pendingCmds.delete(frame.id)
			if (frame.error) pend.reject(new Error(frame.error))
			else pend.resolve(frame.result)
			return
		}
		if (frame.t === "event") {
			for (const listener of listeners) listener(frame.event)
			return
		}
		// host-callback request → serve against the controller's real host.
		try {
			const result = await dispatchHostCall(host, frame.capability, frame.method, frame.params)
			send({ t: "hostResult", id: frame.id, result })
		} catch (e) {
			send({ t: "hostResult", id: frame.id, error: errMsg(e) })
		}
	}

	return { api, receive }
}
