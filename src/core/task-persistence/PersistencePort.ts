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
 * Message persistence port (todos/opencode_inspired_work.md §5, and the seam §9
 * needs to make the core host-agnostic).
 *
 * Today the conversation/UI message logs are flat JSONL files, accessed through
 * free functions in `apiMessages.ts` / `taskMessages.ts`. This interface is the
 * single seam those reads/writes go through, so the storage backend can be
 * swapped (e.g. for an event-sourced SQLite store) without touching call sites.
 *
 * `FileSystemMessagePersistence` is the current backend — a thin, behavior-
 * preserving adapter over the existing functions. The strangler plan:
 *   1. introduce this port + adapter (done here);
 *   2. route Task.ts's persistence call sites through an injected port;
 *   3. add a `SqliteMessagePersistence` backend + a one-time importer (needs the
 *      migration-strategy decision in Part E #5) and retire the flat-file
 *      perf machinery (debounced saves / append logs / tail reads).
 */
export interface MessagePersistencePort {
	// API conversation history (the LLM-facing message log).
	appendApiMessage(taskId: string, message: ApiMessage): Promise<void>
	readApiMessages(taskId: string): Promise<ApiMessage[]>
	/** Last `maxMessages` records; returns `[messages, hasMore]`. */
	readApiMessagesTail(taskId: string, maxMessages: number): Promise<[ApiMessage[], boolean]>
	saveApiMessages(taskId: string, messages: ApiMessage[], serialized?: string): Promise<void>

	// UI (Shofer) message log.
	appendTaskMessage(taskId: string, message: ShoferMessage): Promise<void>
	readTaskMessages(taskId: string): Promise<ShoferMessage[]>
	readTaskMessagesTail(taskId: string, maxMessages: number): Promise<[ShoferMessage[], boolean]>
	saveTaskMessages(taskId: string, messages: ShoferMessage[], serialized?: string): Promise<void>

	/** Release the long-lived append file handle for a task (lifecycle/teardown). */
	disposeAppendHandleForTask(taskId: string): Promise<void>
}

/**
 * Flat-file backend: delegates to the existing JSONL persistence functions,
 * binding `globalStoragePath` once. Behavior-identical to calling them directly.
 */
export class FileSystemMessagePersistence implements MessagePersistencePort {
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

	saveApiMessages(taskId: string, messages: ApiMessage[], serialized?: string): Promise<void> {
		return saveApiMessages({ messages, taskId, globalStoragePath: this.globalStoragePath, serialized })
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

	saveTaskMessages(taskId: string, messages: ShoferMessage[], serialized?: string): Promise<void> {
		return saveTaskMessages({ messages, taskId, globalStoragePath: this.globalStoragePath, serialized })
	}

	disposeAppendHandleForTask(taskId: string): Promise<void> {
		return disposeAppendHandleForTask({ taskId, globalStoragePath: this.globalStoragePath })
	}
}
