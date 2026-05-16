import { Anthropic } from "@anthropic-ai/sdk"
import os from "os"
import * as path from "path"
import * as vscode from "vscode"

import type { ExtendedContentBlock } from "./export-markdown"

/**
 * JSON task trace export — produces a structured, machine-readable trace
 * of the entire LLM conversation enriched with per-request token usage,
 * cost, and tool call metadata.
 */

// ── Types ─────────────────────────────────────────────────────

export interface JsonExportCall {
	/** 1-based index of this API call within the task. */
	index: number
	/** Provider (e.g. "anthropic", "openai-native"). */
	apiProtocol?: string
	/** Model ID used for this request. */
	model?: string
	/** Input tokens consumed. */
	inputTokens: number
	/** Output tokens produced. */
	outputTokens: number
	/** Cache write tokens (prompt caching). */
	cacheWriteTokens: number
	/** Cache read tokens (prompt caching). */
	cacheReadTokens: number
	/** Estimated cost in USD. */
	costUsd: number
	/** Whether the request was cancelled mid-stream. */
	cancelled?: boolean
	/** Reason for cancellation if cancelled. */
	cancelReason?: string
	/** Error message if the stream failed. */
	streamingFailedMessage?: string
	/** The messages sent in this API request (user → assistant). */
	messages: Anthropic.Messages.MessageParam[]
	/** Tool calls extracted from the assistant response. */
	toolCalls: JsonExportToolCall[]
	/** Extended thinking / chain-of-thought content if present. */
	reasoning?: string
	/** Number of retries before this attempt (0 = first try). */
	retryAttempt?: number
	/** Structured error information if this call failed. */
	error?: {
		message: string
		type?: string
		statusCode?: number
		stack?: string
	}
	/** Serialised wire-level request metadata captured before the call. */
	wireRequest?: string
	/** Present when tokens are estimated via char/4 heuristic rather than provider usage chunks. */
	_tokensEstimated?: true
}

export interface JsonExportToolCall {
	name: string
	id: string
	input: Record<string, unknown>
	result?: {
		content: unknown
		isError: boolean
	}
}

export interface JsonExportTrace {
	/** Export format version for forward compatibility. */
	version: 1
	/** Task identifier. */
	taskId: string
	/** Human-readable task description. */
	task: string
	/** Mode slug (e.g. "code", "architect"). */
	mode?: string
	/** Timestamp when the task was created (ISO 8601). */
	createdAt: string
	/** Individual API calls in chronological order. */
	calls: JsonExportCall[]
	/** Aggregate token usage across all calls. */
	totalTokens: {
		input: number
		output: number
		cacheWrite: number
		cacheRead: number
	}
	/** Total estimated cost in USD. */
	totalCostUsd: number
	/** Number of API calls. */
	totalCalls: number
	/** Number of tool calls across all API calls. */
	totalToolCalls: number
}

/**
 * Parsed ui_messages.json entry for `api_req_started`.
 * Initially contains only `{apiProtocol}`; enriched later with cost/tokens.
 */
interface UiApiReqStarted {
	say: "api_req_started"
	ts: number
	text: string // JSON string — see UiApiReqStartedPayload
}

interface UiApiReqStartedPayload {
	apiProtocol?: string
	model?: string
	// Stored field names from ShoferApiReqInfo in Task.ts:
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	cost?: number
	cancelled?: boolean
	cancelReason?: string
	streamingFailedMessage?: string
	retryAttempt?: number
	error?: {
		message: string
		type?: string
		statusCode?: number
		stack?: string
	}
	wireRequest?: string
}

// ── Token estimation fallback ─────────────────────────────────

/**
 * Rough token count from raw text.  Uses the character/4 heuristic
 * common for English prose; close enough for trace diagnostics when
 * the provider does not emit `usage` chunks in streaming mode.
 *
 * @param text - Input text to estimate
 * @returns Approximate token count
 */
function estimateTokens(text: string): number {
	if (!text) return 0
	return Math.ceil(text.length / 4)
}

/**
 * Estimate tokens for a content block.
 */
function estimateBlockTokens(block: Record<string, unknown>): number {
	if (typeof block.text === "string") return estimateTokens(block.text)
	if (typeof block.content === "string") return estimateTokens(block.content)
	// tool_use: count the JSON-serialized input
	if (block.type === "tool_use" && block.input) {
		return estimateTokens(JSON.stringify(block.input))
	}
	return 0
}

/**
 * Estimate total input + output tokens for an array of `MessageParam`
 * messages using the char/4 heuristic.
 */
function estimateMessageTokens(messages: Anthropic.Messages.MessageParam[]): {
	input: number
	output: number
} {
	let input = 0
	let output = 0
	for (const msg of messages) {
		const blocks = Array.isArray(msg.content) ? msg.content : [{ text: String(msg.content ?? "") }]
		for (const block of blocks) {
			const tokens = estimateBlockTokens(block as Record<string, unknown>)
			if (msg.role === "user") input += tokens
			else output += tokens
		}
	}
	return { input, output }
}

// ── Public API ────────────────────────────────────────────────

/**
 * Build a filename for the JSON export.
 */
export function getJsonExportFileName(dateTs: number): string {
	const date = new Date(dateTs)
	const month = date.toLocaleString("en-US", { month: "short" }).toLowerCase()
	const day = date.getDate()
	const year = date.getFullYear()
	let hours = date.getHours()
	const minutes = date.getMinutes().toString().padStart(2, "0")
	const seconds = date.getSeconds().toString().padStart(2, "0")
	const ampm = hours >= 12 ? "pm" : "am"
	hours = hours % 12
	hours = hours ? hours : 12
	return `shofer_task_${month}-${day}-${year}_${hours}-${minutes}-${seconds}-${ampm}.json`
}

/**
 * Build a complete JSON trace from the task's persisted files.
 *
 * @param taskId - The task identifier.
 * @param taskText - Human-readable task description.
 * @param mode - Mode slug (e.g. "code").
 * @param createdAt - ISO 8601 creation timestamp.
 * @param apiConversationHistory - The full API conversation (Anthropic format).
 * @param uiMessages - Parsed ui_messages.json array.
 */
export function buildJsonTrace(
	taskId: string,
	taskText: string,
	mode: string | undefined,
	createdAt: string,
	apiConversationHistory: Anthropic.Messages.MessageParam[],
	uiMessages: Array<{ type: string; say?: string; ts: number; text?: string }>,
): JsonExportTrace {
	const calls: JsonExportCall[] = []

	// Index the api_req_started entries by their position in the UI message stream.
	const apiReqStartedEntries = uiMessages.filter(
		(m) => m.type === "say" && m.say === "api_req_started",
	) as UiApiReqStarted[]

	// Walk the API conversation history and partition it by API call.
	// An API call is: user message(s) → assistant message.
	// The user messages carry tool_results from the previous turn; the
	// assistant message carries text + tool_uses for the current turn.
	let currentCallStart = 0
	let callIndex = 0

	for (let i = 0; i < apiConversationHistory.length; i++) {
		const msg = apiConversationHistory[i]

		if (msg.role === "assistant") {
			// An assistant message closes an API call.
			// Collect all messages from currentCallStart through this assistant message.
			const callMessages = apiConversationHistory.slice(currentCallStart, i + 1)

			// Find the matching api_req_started entry.
			const reqMeta = apiReqStartedEntries[callIndex]
			let payload: UiApiReqStartedPayload = {}
			if (reqMeta?.text) {
				try {
					payload = JSON.parse(reqMeta.text)
				} catch {
					/* best effort */
				}
			}

			// Extract tool calls and reasoning from the assistant content.
			const toolCalls: JsonExportToolCall[] = []
			let reasoning: string | undefined

			if (Array.isArray(msg.content)) {
				for (const rawBlock of msg.content) {
					const block = rawBlock as ExtendedContentBlock
					if (block.type === "tool_use") {
						const resultMsg = apiConversationHistory[i + 1]
						let result: { content: unknown; isError: boolean } | undefined

						if (resultMsg?.role === "user" && Array.isArray(resultMsg.content)) {
							const matchingResult = resultMsg.content.find(
								(b) => b.type === "tool_result" && b.tool_use_id === block.id,
							)
							if (matchingResult && matchingResult.type === "tool_result") {
								result = {
									content: matchingResult.content,
									isError: matchingResult.is_error ?? false,
								}
							}
						}

						toolCalls.push({
							name: block.name,
							id: block.id,
							input: (block.input as Record<string, unknown>) || {},
							result,
						})
					} else if (block.type === "reasoning") {
						if ("text" in block && typeof block.text === "string") {
							reasoning = (reasoning || "") + block.text
						}
					} else if (block.type === "thinking") {
						// Anthropic extended thinking format
						const thinkingBlock = block as { thinking: string }
						if (typeof thinkingBlock.thinking === "string") {
							reasoning = (reasoning || "") + thinkingBlock.thinking
						}
					}
				}
			}

			calls.push({
				index: callIndex + 1,
				apiProtocol: payload.apiProtocol,
				model: payload.model,
				inputTokens: payload.tokensIn ?? 0,
				outputTokens: payload.tokensOut ?? 0,
				cacheWriteTokens: payload.cacheWrites ?? 0,
				cacheReadTokens: payload.cacheReads ?? 0,
				costUsd: payload.cost ?? 0,
				cancelled: payload.cancelled,
				cancelReason: payload.cancelReason,
				streamingFailedMessage: payload.streamingFailedMessage,
				messages: callMessages,
				toolCalls,
				reasoning: reasoning || undefined,
				retryAttempt: payload.retryAttempt,
				error: payload.error,
				wireRequest: payload.wireRequest,
			})

			callIndex++
			currentCallStart = i + 1
		}
	}

	// Handle api_req_started entries that have no matching assistant messages.
	// This covers error-only tasks where the API never returned a response,
	// e.g. connection failures, rate limits, or empty streams.
	// Without this, the export would show an empty `calls[]` array.
	while (callIndex < apiReqStartedEntries.length) {
		const reqMeta = apiReqStartedEntries[callIndex]
		let payload: UiApiReqStartedPayload = {}
		if (reqMeta?.text) {
			try {
				payload = JSON.parse(reqMeta.text)
			} catch {
				/* best effort */
			}
		}

		calls.push({
			index: callIndex + 1,
			apiProtocol: payload.apiProtocol,
			model: payload.model,
			inputTokens: payload.tokensIn ?? 0,
			outputTokens: payload.tokensOut ?? 0,
			cacheWriteTokens: payload.cacheWrites ?? 0,
			cacheReadTokens: payload.cacheReads ?? 0,
			costUsd: payload.cost ?? 0,
			cancelled: payload.cancelled,
			cancelReason: payload.cancelReason,
			streamingFailedMessage: payload.streamingFailedMessage,
			messages: [],
			toolCalls: [],
			retryAttempt: payload.retryAttempt,
			error: payload.error,
			wireRequest: payload.wireRequest,
		})

		callIndex++
	}

	// If the provider did not emit `usage` chunks (common with
	// streaming-only providers), fall back to char/4 heuristic so the
	// trace still carries useful token estimates.
	const allZeroTokens = calls.length > 0 && calls.every((c) => c.inputTokens === 0 && c.outputTokens === 0)
	if (allZeroTokens) {
		for (const call of calls) {
			const est = estimateMessageTokens(call.messages)
			call.inputTokens = est.input
			call.outputTokens = est.output
			// Mark as estimated so consumers can distinguish from real values.
			call._tokensEstimated = true
		}
	}

	// Compute aggregates.
	let totalInput = 0
	let totalOutput = 0
	let totalCacheWrite = 0
	let totalCacheRead = 0
	let totalCost = 0
	let totalToolCalls = 0

	for (const call of calls) {
		totalInput += call.inputTokens
		totalOutput += call.outputTokens
		totalCacheWrite += call.cacheWriteTokens
		totalCacheRead += call.cacheReadTokens
		totalCost += call.costUsd
		totalToolCalls += call.toolCalls.length
	}

	return {
		version: 1,
		taskId,
		task: taskText,
		mode,
		createdAt,
		calls,
		totalTokens: {
			input: totalInput,
			output: totalOutput,
			cacheWrite: totalCacheWrite,
			cacheRead: totalCacheRead,
		},
		totalCostUsd: totalCost,
		totalCalls: calls.length,
		totalToolCalls,
	}
}

/**
 * Prompt the user for a save location and write the JSON trace to disk.
 *
 * @param dateTs - Task creation timestamp (for filename).
 * @param trace - The built JSON export trace.
 * @param defaultUri - Default save URI.
 * @returns The URI of the saved file, or undefined if the user cancelled.
 */
export async function downloadJsonTask(
	dateTs: number,
	trace: JsonExportTrace,
	defaultUri: vscode.Uri,
): Promise<vscode.Uri | undefined> {
	const fileName = getJsonExportFileName(dateTs)

	const jsonContent = JSON.stringify(trace, null, 2)

	const saveUri = await vscode.window.showSaveDialog({
		filters: { JSON: ["json"] },
		defaultUri,
	})

	if (saveUri) {
		await vscode.workspace.fs.writeFile(saveUri, Buffer.from(jsonContent))
		vscode.window.showTextDocument(saveUri, { preview: true })
		return saveUri
	}
	return undefined
}
