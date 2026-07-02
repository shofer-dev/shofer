import type { TextContent, ToolUse, McpToolUse } from "@shofer/types"

export type AssistantMessageContent = TextContent | ToolUse | McpToolUse
