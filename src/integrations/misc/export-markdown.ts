import { Anthropic } from "@anthropic-ai/sdk"
import * as vscode from "vscode"

// Extended content block types to support new Anthropic API features
interface ReasoningBlock {
	type: "reasoning"
	text: string
}

interface ThoughtSignatureBlock {
	type: "thoughtSignature"
}

export type ExtendedContentBlock = Anthropic.Messages.ContentBlockParam | ReasoningBlock | ThoughtSignatureBlock

export function getTaskFileName(dateTs: number): string {
	const date = new Date(dateTs)
	const month = date.toLocaleString("en-US", { month: "short" }).toLowerCase()
	const day = date.getDate()
	const year = date.getFullYear()
	let hours = date.getHours()
	const minutes = date.getMinutes().toString().padStart(2, "0")
	const seconds = date.getSeconds().toString().padStart(2, "0")
	const ampm = hours >= 12 ? "pm" : "am"
	hours = hours % 12
	hours = hours ? hours : 12 // the hour '0' should be '12'
	return `shofer_task_${month}-${day}-${year}_${hours}-${minutes}-${seconds}-${ampm}.md`
}

/**
 * Render a task's API conversation history as a human-readable markdown
 * transcript. Extracted so the same content can either be written to disk
 * ({@link downloadTask}) or streamed to the browser for a client-side download.
 */
export function buildTaskMarkdown(conversationHistory: Anthropic.MessageParam[]): string {
	return conversationHistory
		.map((message) => {
			const role = message.role === "user" ? "**User:**" : "**Assistant:**"
			const content = Array.isArray(message.content)
				? message.content.map((block) => formatContentBlockToMarkdown(block as ExtendedContentBlock)).join("\n")
				: message.content
			return `${role}\n\n${content}\n\n`
		})
		.join("---\n\n")
}

export async function downloadTask(
	dateTs: number,
	conversationHistory: Anthropic.MessageParam[],
	defaultUri: vscode.Uri,
): Promise<vscode.Uri | undefined> {
	return saveMarkdownFile(buildTaskMarkdown(conversationHistory), defaultUri)
}

/**
 * Prompt for a save location and write markdown content there, opening the
 * result in an editor.
 */
export async function saveMarkdownFile(
	markdownContent: string,
	defaultUri: vscode.Uri,
): Promise<vscode.Uri | undefined> {
	// Prompt user for save location
	const saveUri = await vscode.window.showSaveDialog({
		filters: { Markdown: ["md"] },
		defaultUri,
	})

	if (saveUri) {
		// Write content to the selected location
		await vscode.workspace.fs.writeFile(saveUri, Buffer.from(markdownContent))
		vscode.window.showTextDocument(saveUri, { preview: true })
		return saveUri
	}
	return undefined
}

export function formatContentBlockToMarkdown(block: ExtendedContentBlock): string {
	switch (block.type) {
		case "text":
			return block.text
		case "image":
			return `[Image]`
		case "tool_use": {
			let input: string
			if (typeof block.input === "object" && block.input !== null) {
				input = Object.entries(block.input)
					.map(([key, value]) => {
						const formattedKey = key.charAt(0).toUpperCase() + key.slice(1)
						// Handle nested objects/arrays by JSON stringifying them
						const formattedValue =
							typeof value === "object" && value !== null ? JSON.stringify(value, null, 2) : String(value)
						return `${formattedKey}: ${formattedValue}`
					})
					.join("\n")
			} else {
				input = String(block.input)
			}
			return `[Tool Use: ${block.name}]\n${input}`
		}
		case "tool_result": {
			// For now we're not doing tool name lookup since we don't use tools anymore
			// const toolName = findToolName(block.tool_use_id, messages)
			const toolName = "Tool"
			if (typeof block.content === "string") {
				return `[${toolName}${block.is_error ? " (Error)" : ""}]\n${block.content}`
			} else if (Array.isArray(block.content)) {
				return `[${toolName}${block.is_error ? " (Error)" : ""}]\n${block.content
					.map((contentBlock) => formatContentBlockToMarkdown(contentBlock))
					.join("\n")}`
			} else {
				return `[${toolName}${block.is_error ? " (Error)" : ""}]`
			}
		}
		case "reasoning":
			return `[Reasoning]\n${block.text}`
		case "thoughtSignature":
			// Not relevant for human-readable exports
			return ""
		default:
			return `[Unexpected content type: ${block.type}]`
	}
}
