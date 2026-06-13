import { ApiMessage } from "../../core/task-persistence/apiMessages"

import { ApiHandler } from "../index"

/* Removes image blocks from messages if they are not supported by the Api Handler */
export function maybeRemoveImageBlocks(messages: ApiMessage[], apiHandler: ApiHandler): ApiMessage[] {
	// Check model capability ONCE instead of for every message
	const supportsImages = apiHandler.getModel().info.supportsImages

	// Nothing to strip when the model supports images — return the input
	// unchanged instead of shallow-cloning every message each request. [perf H27]
	if (supportsImages) {
		return messages
	}

	return messages.map((message) => {
		// Handle array content (could contain image blocks).
		let { content } = message
		if (Array.isArray(content)) {
			// Convert image blocks to text descriptions.
			content = content.map((block) => {
				if (block.type === "image") {
					// Note: We can't access the actual image content/url due to API limitations,
					// but we can indicate that an image was present in the conversation.
					return {
						type: "text",
						text: "[Referenced image in conversation]",
					}
				}
				return block
			})
		}
		return { ...message, content }
	})
}
