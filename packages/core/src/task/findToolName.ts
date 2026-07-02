import { Anthropic } from "@anthropic-ai/sdk"

/**
 * Resolves the tool name for a given tool-call id by scanning a conversation's
 * message params for the matching `tool_use` block. Pure — no host coupling.
 * @param toolCallId The `tool_use` id to look up
 * @param messages The conversation history to search
 * @returns The tool's name, or "Unknown Tool" if no match is found
 */
export function findToolName(toolCallId: string, messages: Anthropic.MessageParam[]): string {
	for (const message of messages) {
		if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "tool_use" && block.id === toolCallId) {
					return block.name
				}
			}
		}
	}
	return "Unknown Tool"
}
