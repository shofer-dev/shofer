import type { HistoryItem, ShoferMessage } from "@shofer/types"

import {
	type ApiMessage,
	appendApiMessage,
	readApiMessages,
	readApiMessagesTail,
	saveApiMessages,
} from "./apiMessages.js"
import {
	appendTaskMessage,
	disposeAppendHandleForTask,
	readTaskMessages,
	readTaskMessagesTail,
	saveTaskMessages,
} from "./taskMessages.js"
import { FileTaskMetadataPersistence, type TaskMetadataPersistencePort } from "./taskMetadataStore.js"

/**
 * Message persistence port (v3 architecture §5; the seam §9 needs
 * to keep the core host-agnostic).
 *
 * The single interface for task api/UI message reads/writes. The compiled-in
 * backend is SQLite (`message-store.ts`, accessed via the
 * `apiMessages`/`taskMessages` free functions); `SqliteMessagePersistence` is the
 * OO adapter that binds `globalStoragePath` once.
 *
 * Which backend a host actually runs is decided in `backend.ts` — this file only
 * declares the shapes and ships the default.
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
		return appendApiMessage({ message, taskId, globalStoragePath: this.globalStoragePath })
	}
	readApiMessages(taskId: string): Promise<ApiMessage[]> {
		return readApiMessages({ taskId, globalStoragePath: this.globalStoragePath })
	}
	readApiMessagesTail(taskId: string, maxMessages: number): Promise<[ApiMessage[], boolean]> {
		return readApiMessagesTail({ taskId, globalStoragePath: this.globalStoragePath, maxMessages })
	}
	saveApiMessages(taskId: string, messages: ApiMessage[]): Promise<void> {
		return saveApiMessages({ messages, taskId, globalStoragePath: this.globalStoragePath })
	}

	appendTaskMessage(taskId: string, message: ShoferMessage): Promise<void> {
		return appendTaskMessage({ message, taskId, globalStoragePath: this.globalStoragePath })
	}
	readTaskMessages(taskId: string): Promise<ShoferMessage[]> {
		return readTaskMessages({ taskId, globalStoragePath: this.globalStoragePath })
	}
	readTaskMessagesTail(taskId: string, maxMessages: number): Promise<[ShoferMessage[], boolean]> {
		return readTaskMessagesTail({ taskId, globalStoragePath: this.globalStoragePath, maxMessages })
	}
	saveTaskMessages(taskId: string, messages: ShoferMessage[]): Promise<void> {
		return saveTaskMessages({ messages, taskId, globalStoragePath: this.globalStoragePath })
	}

	disposeAppendHandleForTask(taskId: string): Promise<void> {
		return disposeAppendHandleForTask({ taskId, globalStoragePath: this.globalStoragePath })
	}
}
