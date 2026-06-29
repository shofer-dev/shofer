import type { ShoferMessage } from "@shofer/types"

import { type ApiMessage, appendApiMessage, readApiMessages, readApiMessagesTail, saveApiMessages } from "./apiMessages"
import {
	appendTaskMessage,
	disposeAppendHandleForTask,
	readTaskMessages,
	readTaskMessagesTail,
	saveTaskMessages,
} from "./taskMessages"

/**
 * Message persistence port (todos/opencode_inspired_work.md §5; the seam §9 needs
 * to keep the core host-agnostic).
 *
 * The single interface for task api/UI message reads/writes. The backend is
 * SQLite (`message-store.ts`, accessed via the `apiMessages`/`taskMessages` free
 * functions); `SqliteMessagePersistence` is the OO adapter that binds
 * `globalStoragePath` once.
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

/** SQLite-backed port adapter: binds `globalStoragePath` and delegates to the message store. */
export class SqliteMessagePersistence implements MessagePersistencePort {
	constructor(private readonly globalStoragePath: string) {}

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
