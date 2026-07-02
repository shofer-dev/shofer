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
} from "@shofer/core"
// These remain in src (depend on vscode-tainted storage/i18n helpers).
export { taskMetadata } from "./taskMetadata"
export { TaskHistoryStore } from "./TaskHistoryStore"
