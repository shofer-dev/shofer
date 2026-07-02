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
	SqliteMessagePersistence,
	taskMetadata,
	TaskHistoryStore,
} from "@shofer/core"
