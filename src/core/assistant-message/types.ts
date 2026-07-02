import type { TextContent, ToolUse, McpToolUse } from "@shofer/core"

export type AssistantMessageContent = TextContent | ToolUse | McpToolUse
