export const GlobalFileNames = {
	// JSONL (append-only) per §4.1 of docs/mem-utilization-profiling.md.
	// Hard cutover: legacy `*.json` snapshots (and `claude_messages.json`)
	// are unlinked on first read and treated as missing.
	apiConversationHistory: "api_conversation_history.jsonl",
	uiMessages: "ui_messages.jsonl",
	taskMetadata: "task_metadata.json",
	historyItem: "history_item.json",
	historyIndex: "_index.json",
	// One JSON file per task, beside its history — deliberately NOT a field on
	// `HistoryItem`, whose `taskState` has a single writer that the mailbox is not.
	mailbox: "mailbox.json",
}
