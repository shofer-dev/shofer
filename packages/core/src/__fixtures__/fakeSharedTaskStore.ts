import type { HistoryItem, ShoferMessage } from "@shofer/types"

import type { ApiMessage } from "../task-persistence/apiMessages.js"
import type { TaskPersistencePort } from "../task-persistence/PersistencePort.js"

/**
 * An in-memory stand-in for a SHARED task store — the shape a host supplies when
 * several processes serve one pool of tasks (the L2 worker's Postgres backend in
 * production), registered under a name via `registerTaskPersistenceBackend`.
 *
 * It exists so a spec can prove WHICH store a call reached. The distinction is
 * invisible against the local default — SQLite answers correctly for a task it
 * holds — and the bug this fixture guards is precisely a read landing in the
 * wrong store: it returns an empty transcript rather than an error, so the only
 * way to catch it is to select a backend that is observably not SQLite.
 */
export class FakeSharedTaskStore implements TaskPersistencePort {
	readonly ui = new Map<string, ShoferMessage[]>()
	readonly api = new Map<string, ApiMessage[]>()
	readonly metadata = new Map<string, HistoryItem>()
	/** Task ids `disposeAppendHandleForTask` was called for, in order. */
	readonly disposed: string[] = []

	/** Seed a transcript as though another process had written it. */
	setTaskMessages(taskId: string, messages: ShoferMessage[]): void {
		this.ui.set(taskId, [...messages])
	}

	/** Forget everything, so one instance can serve several cases. */
	clear(): void {
		this.ui.clear()
		this.api.clear()
		this.metadata.clear()
		this.disposed.length = 0
	}

	async appendApiMessage(taskId: string, message: ApiMessage): Promise<void> {
		this.api.set(taskId, [...(this.api.get(taskId) ?? []), message])
	}
	async readApiMessages(taskId: string): Promise<ApiMessage[]> {
		return this.api.get(taskId) ?? []
	}
	async readApiMessagesTail(taskId: string, maxMessages: number): Promise<[ApiMessage[], boolean]> {
		const all = this.api.get(taskId) ?? []
		return all.length <= maxMessages ? [all, false] : [all.slice(-maxMessages), true]
	}
	async saveApiMessages(taskId: string, messages: ApiMessage[]): Promise<void> {
		this.api.set(taskId, [...messages])
	}

	async appendTaskMessage(taskId: string, message: ShoferMessage): Promise<void> {
		this.ui.set(taskId, [...(this.ui.get(taskId) ?? []), message])
	}
	async readTaskMessages(taskId: string): Promise<ShoferMessage[]> {
		return this.ui.get(taskId) ?? []
	}
	async readTaskMessagesTail(taskId: string, maxMessages: number): Promise<[ShoferMessage[], boolean]> {
		const all = this.ui.get(taskId) ?? []
		return all.length <= maxMessages ? [all, false] : [all.slice(-maxMessages), true]
	}
	async saveTaskMessages(taskId: string, messages: ShoferMessage[]): Promise<void> {
		this.ui.set(taskId, [...messages])
	}

	async disposeAppendHandleForTask(taskId: string): Promise<void> {
		this.disposed.push(taskId)
	}

	async readTaskMetadata(taskId: string): Promise<HistoryItem | undefined> {
		return this.metadata.get(taskId)
	}
	async writeTaskMetadata(item: HistoryItem): Promise<void> {
		this.metadata.set(item.id, item)
	}
	async deleteTaskMetadata(taskId: string): Promise<void> {
		this.metadata.delete(taskId)
	}
	async listTaskMetadataIds(): Promise<string[]> {
		return [...this.metadata.keys()]
	}
}
