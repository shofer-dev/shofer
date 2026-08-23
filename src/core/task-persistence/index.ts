// Message/api persistence primitives now live in @shofer/core (host-agnostic).
export {
	type ApiMessage,
	appendApiMessage,
	readApiMessages,
	readApiMessagesTail,
	saveApiMessages,
	appendTaskMessage,
	readTaskMessages,
	readTaskMessagesTail,
	saveTaskMessages,
	type MessagePersistencePort,
	type TaskMetadataPersistencePort,
	type TaskPersistencePort,
	SqliteMessagePersistence,
	FileTaskMetadataPersistence,
	registerTaskPersistenceBackend,
	resolveTaskPersistence,
	selectedTaskStoreName,
	taskMetadata,
} from "@shofer/core"
// Remains in src: its src consumer tests mock storage deps via the @shofer/core
// barrel, which only works while TaskHistoryStore imports them from @shofer/core.
export { TaskHistoryStore } from "./TaskHistoryStore"
