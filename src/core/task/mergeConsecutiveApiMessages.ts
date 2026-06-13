import { Anthropic } from "@anthropic-ai/sdk"

import type { ApiMessage } from "../task-persistence"

type Role = ApiMessage["role"]

function normalizeContentToBlocks(content: ApiMessage["content"]): Anthropic.Messages.ContentBlockParam[] {
	if (Array.isArray(content)) {
		return content as Anthropic.Messages.ContentBlockParam[]
	}
	if (content === undefined || content === null) {
		return []
	}
	return [{ type: "text", text: String(content) }]
}

/**
 * Non-destructively merges consecutive messages with the same role.
 *
 * Used for *API request shaping only* (do not use for storage), so rewind/edit operations
 * can still reference the original individual messages.
 */
export function mergeConsecutiveApiMessages(messages: ApiMessage[], options?: { roles?: Role[] }): ApiMessage[] {
	if (messages.length <= 1) {
		return messages
	}

	const mergeRoles = new Set<Role>(options?.roles ?? ["user"]) // default: user only

	// Allow merging regular messages into a summary (API-only shaping),
	// but never merge a summary into something else.
	const canMergePair = (prev: ApiMessage, msg: ApiMessage): boolean =>
		prev.role === msg.role &&
		mergeRoles.has(msg.role) &&
		!msg.isSummary &&
		!prev.isTruncationMarker &&
		!msg.isTruncationMarker

	// Fast path: if no adjacent same-role pair is mergeable, the merge is a
	// no-op. Return the input unchanged instead of allocating and rebuilding
	// the whole array — the common case on the per-request hot path. A scan of
	// adjacent input pairs is a sound predictor because merges only ever combine
	// adjacent elements, so no mergeable input pair ⇒ no merge happens. [perf H27]
	let hasMergeable = false
	for (let i = 1; i < messages.length; i++) {
		if (canMergePair(messages[i - 1], messages[i])) {
			hasMergeable = true
			break
		}
	}
	if (!hasMergeable) {
		return messages
	}

	const out: ApiMessage[] = []

	for (const msg of messages) {
		const prev = out[out.length - 1]
		const canMerge = prev && canMergePair(prev, msg)

		if (!canMerge) {
			out.push(msg)
			continue
		}

		const mergedContent = [...normalizeContentToBlocks(prev.content), ...normalizeContentToBlocks(msg.content)]

		// Preserve the newest ts to keep chronological ordering for downstream logic.
		out[out.length - 1] = {
			...prev,
			content: mergedContent,
			ts: Math.max(prev.ts ?? 0, msg.ts ?? 0) || prev.ts || msg.ts,
		}
	}

	return out
}
