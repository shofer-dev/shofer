import type { HistoryItem, ShoferMessage } from "@shofer/types"

// Type-only: `apiMessages.ts` is a facade that resolves THIS module's backend,
// so a value import here would close a runtime cycle. `ApiMessage` is erased.
import type { ApiMessage } from "./apiMessages.js"
import { storeAppend, storeReadAll, storeReadTail, storeSaveAll } from "./message-store.js"
import { FileTaskMetadataPersistence, type TaskMetadataPersistencePort } from "./taskMetadataStore.js"

/**
 * Message persistence port (v3 architecture §5; the seam §9 needs
 * to keep the core host-agnostic).
 *
 * The single interface for task api/UI message reads/writes. The compiled-in
 * backend is SQLite: `SqliteMessagePersistence` binds `globalStoragePath` once
 * and drives `message-store.ts`, which is that backend's private storage engine
 * and nobody else's.
 *
 * Which backend a host actually runs is decided in `backend.ts` — this file only
 * declares the shapes and ships the default. Callers reach the SELECTED backend
 * through `Task.getPersistence()` or the `apiMessages`/`taskMessages` facades;
 * none of them names this class.
 */
export interface MessagePersistencePort {
	// API conversation history (the LLM-facing message log).
	appendApiMessage(taskId: string, message: ApiMessage): Promise<void>
	readApiMessages(taskId: string): Promise<ApiMessage[]>
	/** Last `maxMessages` records; returns `[messages, hasMore]`. */
	readApiMessagesTail(taskId: string, maxMessages: number): Promise<[ApiMessage[], boolean]>
	saveApiMessages(taskId: string, messages: ApiMessage[]): Promise<void>

	// UI (Shofer) message log.
	appendTaskMessage(taskId: string, message: ShoferMessage): Promise<void>
	readTaskMessages(taskId: string): Promise<ShoferMessage[]>
	readTaskMessagesTail(taskId: string, maxMessages: number): Promise<[ShoferMessage[], boolean]>
	saveTaskMessages(taskId: string, messages: ShoferMessage[]): Promise<void>

	/** Lifecycle/teardown hook (no-op for the SQLite backend; kept for the interface). */
	disposeAppendHandleForTask(taskId: string): Promise<void>
}

/**
 * A claim on the right to DRIVE a task, held for the length of a turn.
 *
 * Only backends whose store is shared between processes have anything to lease;
 * the local-file default exposes none, and a host that finds
 * {@link TaskPersistencePort.lease} absent simply runs unfenced, exactly as it
 * always has.
 */
export interface TaskLease {
	/** The task this claim covers. */
	readonly taskId: string
	/**
	 * The monotonic fencing token the claim was granted at. Every write the
	 * backend makes for this task carries it, so a stale holder's writes are
	 * REJECTED rather than interleaved into the transcript.
	 */
	readonly fence: number
	/** Stop heartbeating and give the claim up. Idempotent. */
	release(): Promise<void>
}

/** Lease support, offered only by backends with a shared store. */
export interface TaskLeaseSupport {
	/**
	 * Claim the task, or reject if another live holder has it.
	 *
	 * The backend heartbeats for as long as the claim is held. `onLost` is the
	 * DISCOVERY signal — it fires when a heartbeat finds the claim gone (expired
	 * and taken, or fenced out by a newer holder) so the caller can abort the
	 * turn loudly. A rejected write is the backstop for the same condition, not
	 * the way it is meant to be noticed.
	 */
	claim(taskId: string, onLost: (reason: Error) => void): Promise<TaskLease>
}

/**
 * The full persistence surface a {@link Task} needs: messages, metadata, and —
 * where the store is shared — leases.
 *
 * This is the type host wiring supplies and `Task.getPersistence()` resolves.
 * `MessagePersistencePort` stays a type of its own because plenty of call sites
 * only ever touch messages.
 */
export interface TaskPersistencePort extends MessagePersistencePort, TaskMetadataPersistencePort {
	/** Present only on backends that can have more than one writer. */
	readonly lease?: TaskLeaseSupport
	/** Release backend-wide resources (pools, timers). Optional; idempotent. */
	dispose?(): Promise<void>
}

/**
 * The compiled-in default: task messages in SQLite (`message-store.ts`), task
 * metadata in per-task `history_item.json` files.
 *
 * Both halves are LOCAL, which is the whole of its contract — it is correct for
 * every host whose task lives where its storage directory lives (VS Code, the
 * CLI, an L1 workspace) and offers no lease, because a local file has exactly
 * one writer by construction.
 *
 * Construct it only from `backend.ts`'s registry. Anything that instantiates it
 * directly has hard-wired the local store and will read an empty transcript on a
 * host whose tasks live in a shared one.
 */
export class SqliteMessagePersistence implements TaskPersistencePort {
	private readonly metadata: TaskMetadataPersistencePort

	constructor(private readonly globalStoragePath: string) {
		this.metadata = new FileTaskMetadataPersistence(globalStoragePath)
	}

	readTaskMetadata(taskId: string): Promise<HistoryItem | undefined> {
		return this.metadata.readTaskMetadata(taskId)
	}
	writeTaskMetadata(item: HistoryItem): Promise<void> {
		return this.metadata.writeTaskMetadata(item)
	}
	deleteTaskMetadata(taskId: string): Promise<void> {
		return this.metadata.deleteTaskMetadata(taskId)
	}
	listTaskMetadataIds(): Promise<string[]> {
		return this.metadata.listTaskMetadataIds()
	}

	appendApiMessage(taskId: string, message: ApiMessage): Promise<void> {
		return storeAppend(this.globalStoragePath, taskId, "api", message)
	}
	readApiMessages(taskId: string): Promise<ApiMessage[]> {
		return storeReadAll<ApiMessage>(this.globalStoragePath, taskId, "api")
	}
	readApiMessagesTail(taskId: string, maxMessages: number): Promise<[ApiMessage[], boolean]> {
		return storeReadTail<ApiMessage>(this.globalStoragePath, taskId, "api", maxMessages)
	}
	saveApiMessages(taskId: string, messages: ApiMessage[]): Promise<void> {
		return storeSaveAll(this.globalStoragePath, taskId, "api", messages)
	}

	appendTaskMessage(taskId: string, message: ShoferMessage): Promise<void> {
		return storeAppend(this.globalStoragePath, taskId, "ui", message)
	}
	readTaskMessages(taskId: string): Promise<ShoferMessage[]> {
		return storeReadAll<ShoferMessage>(this.globalStoragePath, taskId, "ui")
	}
	readTaskMessagesTail(taskId: string, maxMessages: number): Promise<[ShoferMessage[], boolean]> {
		return storeReadTail<ShoferMessage>(this.globalStoragePath, taskId, "ui", maxMessages)
	}
	saveTaskMessages(taskId: string, messages: ShoferMessage[]): Promise<void> {
		return storeSaveAll(this.globalStoragePath, taskId, "ui", messages)
	}

	/** No-op: SQLite keeps no long-lived per-task handle to release. */
	async disposeAppendHandleForTask(_taskId: string): Promise<void> {
		// nothing to release
	}
}
