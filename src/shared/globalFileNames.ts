export const GlobalFileNames = {
	// JSONL (append-only) per §4.1 of docs/mem-utilization-profiling.md.
	// Hard cutover: legacy `*.json` snapshots (and `claude_messages.json`)
	// are unlinked on first read and treated as missing.
	apiConversationHistory: "api_conversation_history.jsonl",
	uiMessages: "ui_messages.jsonl",
	mcpSettings: "mcp_settings.json",
	customModes: "custom_modes.yaml",
	taskMetadata: "task_metadata.json",
	historyItem: "history_item.json",
	historyIndex: "_index.json",
}
