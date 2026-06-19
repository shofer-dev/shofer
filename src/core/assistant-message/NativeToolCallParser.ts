import * as vscode from "vscode"
import { parseJSON } from "partial-json"
import { distance } from "fastest-levenshtein"

import { type ToolName, toolNames, type FileEntry } from "@shofer/types"
import { customToolRegistry } from "@shofer/core"

import {
	type ToolUse,
	type McpToolUse,
	type ToolParamName,
	type NativeToolArgs,
	toolParamNames,
} from "../../shared/tools"
import { resolveToolAlias } from "../prompts/tools/filter-tools-for-mode"
import type {
	ApiStreamToolCallStartChunk,
	ApiStreamToolCallDeltaChunk,
	ApiStreamToolCallEndChunk,
} from "../../api/transform/stream"
import { MCP_TOOL_PREFIX, MCP_TOOL_SEPARATOR, parseMcpToolName, normalizeMcpToolName } from "../../utils/mcp-name"

/**
 * Helper type to extract properly typed native arguments for a given tool.
 * Returns the type from NativeToolArgs if the tool is defined there, otherwise never.
 */
type NativeArgsFor<TName extends ToolName> = TName extends keyof NativeToolArgs ? NativeToolArgs[TName] : never

import { isPrivateLmTool } from "../task/build-tools"
import { webviewLog } from "../../utils/logging/subsystems"

/**
 * Find the closest matching tool name from a list of candidates using
 * Levenshtein distance. Returns the candidate with the smallest edit
 * distance, or undefined if the candidates list is empty.
 */
function findClosestToolName(haystack: string, candidates: readonly string[]): string | undefined {
	if (candidates.length === 0) return undefined

	let best = candidates[0]
	let bestDist = distance(haystack, best)

	for (let i = 1; i < candidates.length; i++) {
		const dist = distance(haystack, candidates[i])
		if (dist < bestDist) {
			bestDist = dist
			best = candidates[i]
		}
	}

	return best
}

/**
 * Parser for native tool calls (OpenAI-style function calling).
 * Converts native tool call format to ToolUse format for compatibility
 * with existing tool execution infrastructure.
 *
 * For tools with refactored parsers (e.g., read_file), this parser provides
 * typed arguments via nativeArgs. Tool-specific handlers should consume
 * nativeArgs directly rather than relying on synthesized legacy params.
 */
/**
 * Event types returned from raw chunk processing.
 */
export type ToolCallStreamEvent = ApiStreamToolCallStartChunk | ApiStreamToolCallDeltaChunk | ApiStreamToolCallEndChunk

/**
 * Parser for native tool calls (OpenAI-style function calling).
 * Converts native tool call format to ToolUse format for compatibility
 * with existing tool execution infrastructure.
 *
 * For tools with refactored parsers (e.g., read_file), this parser provides
 * typed arguments via nativeArgs. Tool-specific handlers should consume
 * nativeArgs directly rather than relying on synthesized legacy params.
 *
 * This class also handles raw tool call chunk processing, converting
 * provider-level raw chunks into start/delta/end events.
 */
export class NativeToolCallParser {
	/** Stores the last parse error so callers can include specifics in error messages. */
	public static lastParseError: string | null = null

	/** Read and clear the last parse error. */
	public static consumeLastParseError(): string | null {
		const err = this.lastParseError
		this.lastParseError = null
		return err
	}

	// Streaming state management for argument accumulation (keyed by tool call id)
	// Note: name is string to accommodate dynamic MCP tools (mcp--serverName--toolName)
	private static streamingToolCalls = new Map<
		string,
		{
			id: string
			name: string
			argumentsAccumulator: string
		}
	>()

	// Raw chunk tracking state (keyed by index from API stream)
	private static rawChunkTracker = new Map<
		number,
		{
			id: string
			name: string
			hasStarted: boolean
			deltaBuffer: string[]
		}
	>()

	private static coerceOptionalBoolean(value: unknown): boolean | undefined {
		if (typeof value === "boolean") {
			return value
		}
		if (typeof value === "string") {
			const lower = value.trim().toLowerCase()
			if (lower === "true") {
				return true
			}
			if (lower === "false") {
				return false
			}
		}
		return undefined
	}

	/**
	 * Process a raw tool call chunk from the API stream.
	 * Handles tracking, buffering, and emits start/delta/end events.
	 *
	 * This is the entry point for providers that emit tool_call_partial chunks.
	 * Returns an array of events to be processed by the consumer.
	 */
	public static processRawChunk(chunk: {
		index: number
		id?: string
		name?: string
		arguments?: string
	}): ToolCallStreamEvent[] {
		const events: ToolCallStreamEvent[] = []
		const { index, id, name, arguments: args } = chunk

		let tracked = this.rawChunkTracker.get(index)

		// Initialize new tool call tracking when we receive an id
		if (id && !tracked) {
			tracked = {
				id,
				name: name || "",
				hasStarted: false,
				deltaBuffer: [],
			}
			this.rawChunkTracker.set(index, tracked)
		}

		if (!tracked) {
			return events
		}

		// Update name if present in chunk and not yet set
		if (name) {
			tracked.name = name
		}

		// Emit start event when we have the name
		if (!tracked.hasStarted && tracked.name) {
			events.push({
				type: "tool_call_start",
				id: tracked.id,
				name: tracked.name,
			})
			tracked.hasStarted = true

			// Flush buffered deltas
			for (const bufferedDelta of tracked.deltaBuffer) {
				events.push({
					type: "tool_call_delta",
					id: tracked.id,
					delta: bufferedDelta,
				})
			}
			tracked.deltaBuffer = []
		}

		// Emit delta event for argument chunks
		if (args) {
			if (tracked.hasStarted) {
				events.push({
					type: "tool_call_delta",
					id: tracked.id,
					delta: args,
				})
			} else {
				tracked.deltaBuffer.push(args)
			}
		}

		return events
	}

	/**
	 * Process stream finish reason.
	 * Emits end events when finish_reason is 'tool_calls'.
	 */
	public static processFinishReason(finishReason: string | null | undefined): ToolCallStreamEvent[] {
		const events: ToolCallStreamEvent[] = []

		if (finishReason === "tool_calls" && this.rawChunkTracker.size > 0) {
			for (const [, tracked] of this.rawChunkTracker.entries()) {
				events.push({
					type: "tool_call_end",
					id: tracked.id,
				})
			}
		}

		return events
	}

	/**
	 * Finalize any remaining tool calls that weren't explicitly ended.
	 * Should be called at the end of stream processing.
	 */
	public static finalizeRawChunks(): ToolCallStreamEvent[] {
		const events: ToolCallStreamEvent[] = []

		if (this.rawChunkTracker.size > 0) {
			for (const [, tracked] of this.rawChunkTracker.entries()) {
				if (tracked.hasStarted) {
					events.push({
						type: "tool_call_end",
						id: tracked.id,
					})
				}
			}
			this.rawChunkTracker.clear()
		}

		return events
	}

	/**
	 * Clear all raw chunk tracking state.
	 * Should be called when a new API request starts.
	 */
	public static clearRawChunkState(): void {
		this.rawChunkTracker.clear()
	}

	/**
	 * Start streaming a new tool call.
	 * Initializes tracking for incremental argument parsing.
	 * Accepts string to support both ToolName and dynamic MCP tools (mcp--serverName--toolName).
	 */
	public static startStreamingToolCall(id: string, name: string): void {
		this.streamingToolCalls.set(id, {
			id,
			name,
			argumentsAccumulator: "",
		})
	}

	/**
	 * Clear all streaming tool call state.
	 * Should be called when a new API request starts to prevent memory leaks
	 * from interrupted streams.
	 */
	public static clearAllStreamingToolCalls(): void {
		this.streamingToolCalls.clear()
	}

	/**
	 * Check if there are any active streaming tool calls.
	 * Useful for debugging and testing.
	 */
	public static hasActiveStreamingToolCalls(): boolean {
		return this.streamingToolCalls.size > 0
	}

	/**
	 * Process a chunk of JSON arguments for a streaming tool call.
	 * Uses partial-json-parser to extract values from incomplete JSON immediately.
	 * Returns a partial ToolUse with currently parsed parameters.
	 */
	public static processStreamingChunk(id: string, chunk: string): ToolUse | null {
		const toolCall = this.streamingToolCalls.get(id)
		if (!toolCall) {
			return null
		}

		// Accumulate the JSON string
		toolCall.argumentsAccumulator += chunk

		// For dynamic MCP tools, we don't return partial updates - wait for final
		const mcpPrefix = MCP_TOOL_PREFIX + MCP_TOOL_SEPARATOR
		if (toolCall.name.startsWith(mcpPrefix)) {
			return null
		}

		// Parse whatever we can from the incomplete JSON!
		// partial-json-parser extracts partial values (strings, arrays, objects) immediately
		try {
			const partialArgs = parseJSON(toolCall.argumentsAccumulator)
			this.normalizeArgAliases(partialArgs)

			// Resolve tool alias to canonical name
			const resolvedName = resolveToolAlias(toolCall.name) as ToolName
			// Preserve original name if it differs from resolved (i.e., it was an alias)
			const originalName = toolCall.name !== resolvedName ? toolCall.name : undefined

			// Create partial ToolUse with extracted values
			return this.createPartialToolUse(
				toolCall.id,
				resolvedName,
				partialArgs || {},
				true, // partial
				originalName,
			)
		} catch {
			// Even partial-json-parser can fail on severely malformed JSON
			// Return null and wait for next chunk
			return null
		}
	}

	/**
	 * Finalize a streaming tool call.
	 * Parses the complete JSON and returns the final ToolUse or McpToolUse.
	 */
	public static finalizeStreamingToolCall(id: string): ToolUse | McpToolUse | null {
		const toolCall = this.streamingToolCalls.get(id)
		if (!toolCall) {
			this.lastParseError = `Unknown streaming tool call ID "${id}" — may have been finalized already or never started`
			return null
		}

		// Parse the complete accumulated JSON
		// Cast to any for the name since parseToolCall handles both ToolName and dynamic MCP tools
		const finalToolUse = this.parseToolCall({
			id: toolCall.id,
			name: toolCall.name as ToolName,
			arguments: toolCall.argumentsAccumulator,
		})

		// Clean up streaming state
		this.streamingToolCalls.delete(id)

		return finalToolUse
	}

	/**
	 * Some models (particularly vscode-lm with composite shofer/* models) leak
	 * XML-style <parameter> tags into JSON string values when the parameter
	 * list is complex. This is most commonly observed with apply_diff, where
	 * the model embeds a trailing "\n<parameter name=\"path\" string=\"true\">PATH"
	 * suffix inside the `diff` string value instead of emitting `path` as a
	 * separate JSON key. The JSON is structurally valid ({ "diff": "content" }),
	 * so JSON.parse succeeds, but the `path` guard in the parser switch case
	 * then fails because `args.path` is undefined.
	 *
	 * This helper attempts to recover a `path` from the suffix of a string value
	 * that ends with the proprietary <parameter> leak pattern. Returns the
	 * extracted path and the sanitized string, or null if no leak is detected.
	 */
	private static extractPathFromXMLLeak(value: unknown): { path: string; sanitized: string } | null {
		if (typeof value !== "string") return null
		// Pattern: newline + <parameter name="path" string="true">VALUE at end of string
		// The closing </parameter> may or may not be present.
		// Tolerate corrupted tag prefixes: vscode-lm / deepseek-v4-pro sometimes
		// substitute Unicode box-drawing junk (U+FF5C, U+2BFF, etc.) for the
		// expected "<" and subsequent characters before "parameter".  The .*?
		// quantifier lazily skips any arbitrary bytes between "<" and the
		// literal "parameter" keyword, which is the only anchoring token.
		//
		// Known limitations:
		// - A corrupted prefix that spans multiple lines is not recovered
		//   (no dotAll flag, so "." does not match newlines).  The observed
		//   corruption is single-line, so this is acceptable.
		// - Theoretically, if a diff SEARCH/REPLACE block legitimately ends
		//   with text matching "<parameter name=\"path\" string=\"true\">VALUE",
		//   the recovery could false-match.  In practice the "$" end-of-string
		//   anchor and the ">>>>>>> REPLACE\n" structural barrier make this
		//   extremely unlikely.  No false positives have been observed.
		const match = value.match(/\n<.*?parameter\s+name="path"\s+string="true">([^\n<]+)\s*(?:<\/parameter>)?\s*$/)
		if (!match) return null
		const extractedPath = match[1].trim()
		if (!extractedPath) return null
		const sanitized = value.slice(0, match.index!)
		return { path: extractedPath, sanitized }
	}

	/**
	 * Common argument-name aliases that some models emit instead of Shofer's
	 * canonical `path` (e.g. Anthropic/Claude-Code's `file_path`, Cursor's
	 * `target_directory`). Mapped to `path` so a model trained on a different
	 * tool schema still parses. The existing per-tool `?? filePath` fallbacks
	 * stay as a backstop; this centralizes the snake_case variants too.
	 */
	private static readonly PATH_ARG_ALIASES = [
		"directory",
		"file_path",
		"filePath",
		"filepath",
		"target_directory",
		"targetDirectory",
		"directory_path",
		"dir_path",
	]

	/**
	 * Normalize known argument-name aliases onto their canonical Shofer names,
	 * in place. Only fills a canonical field when it is absent (never clobbers an
	 * explicitly-provided value). Applied right after JSON parsing so both the
	 * required-field check and the per-tool arg builders see the canonical name.
	 */
	private static normalizeArgAliases(args: unknown): void {
		if (!args || typeof args !== "object") return
		const a = args as Record<string, unknown>
		if (a.path === undefined) {
			for (const alias of this.PATH_ARG_ALIASES) {
				if (a[alias] !== undefined) {
					a.path = a[alias]
					break
				}
			}
		}
		// Alias Anthropic/Claude naming conventions for delegation/messaging tools.
		// `prompt` (full instructions) → `message` (Shofer canonical name).
		// `description` (short summary) → `title` (optional display label).
		// Only fills when the canonical key is absent, same as PATH_ARG_ALIASES above.
		if (a.message === undefined && a.prompt !== undefined) {
			a.message = a.prompt
		}
		if (a.title === undefined && a.description !== undefined) {
			a.title = a.description
		}
	}

	/**
	 * Return the list of required fields that are missing from the parsed
	 * arguments for the given tool. Used by the generic error message in
	 * parseToolCall to tell the model exactly what it forgot.
	 */
	private static missingRequiredFields(toolName: ToolName, args: Record<string, unknown>): string[] {
		const missing: string[] = []
		switch (toolName) {
			case "apply_diff":
				if (args.path === undefined && args.filePath === undefined) missing.push("path")
				if (args.diff === undefined) missing.push("diff")
				break
			case "write_to_file":
				if (args.path === undefined && args.filePath === undefined) missing.push("path")
				if (args.content === undefined) missing.push("content")
				break
			case "execute_command":
				if (args.command === undefined) missing.push("command")
				break
			case "grep_search":
				if (args.path === undefined && args.filePath === undefined) missing.push("path")
				if (args.query === undefined && args.pattern === undefined) missing.push("query")
				break
			case "rag_search":
				if (args.query === undefined) missing.push("query")
				break
			case "read_file":
				if (args.path === undefined && args.filePath === undefined) missing.push("path")
				break
			case "sed":
				if (args.path === undefined && args.filePath === undefined) missing.push("path")
				if (args.pattern === undefined) missing.push("pattern")
				if (args.replacement === undefined) missing.push("replacement")
				break
			case "attempt_completion":
				if (args.result === undefined) missing.push("result")
				break
			case "switch_mode":
				if (args.mode_slug === undefined) missing.push("mode_slug")
				if (args.reason === undefined) missing.push("reason")
				break
			case "new_task":
				if (args.mode === undefined) missing.push("mode")
				if (args.message === undefined) missing.push("message")
				break
			default:
				break
		}
		return missing
	}

	private static coerceOptionalNumber(value: unknown): number | undefined {
		if (typeof value === "number" && Number.isFinite(value)) {
			return value
		}
		if (typeof value === "string") {
			const n = Number(value)
			if (Number.isFinite(n)) {
				return n
			}
		}
		return undefined
	}

	/**
	 * Convert raw file entries from API (with line_ranges) to FileEntry objects
	 * (with lineRanges). Handles multiple formats for backward compatibility:
	 *
	 * New tuple format: { path: string, line_ranges: [[1, 50], [100, 150]] }
	 * Object format: { path: string, line_ranges: [{ start: 1, end: 50 }] }
	 * Legacy string format: { path: string, line_ranges: ["1-50"] }
	 *
	 * Returns: { path: string, lineRanges: [{ start: 1, end: 50 }] }
	 */
	private static convertFileEntries(files: unknown[]): FileEntry[] {
		return files.map((file: unknown) => {
			const f = file as Record<string, unknown>
			const entry: FileEntry = { path: f.path as string }
			if (f.line_ranges && Array.isArray(f.line_ranges)) {
				entry.lineRanges = (f.line_ranges as unknown[])
					.map((range: unknown) => {
						// Handle tuple format: [start, end]
						if (Array.isArray(range) && range.length >= 2) {
							return { start: Number(range[0]), end: Number(range[1]) }
						}
						// Handle object format: { start: number, end: number }
						if (typeof range === "object" && range !== null && "start" in range && "end" in range) {
							const r = range as { start: unknown; end: unknown }
							return { start: Number(r.start), end: Number(r.end) }
						}
						// Handle legacy string format: "1-50"
						if (typeof range === "string") {
							const match = range.match(/^(\d+)-(\d+)$/)
							if (match) {
								return { start: parseInt(match[1], 10), end: parseInt(match[2], 10) }
							}
						}
						return null
					})
					.filter((r): r is { start: number; end: number } => r !== null)
			}
			return entry
		})
	}

	/**
	 * Create a partial ToolUse from currently parsed arguments.
	 * Used during streaming to show progress.
	 * @param originalName - The original tool name as called by the model (if different from canonical name)
	 */
	private static createPartialToolUse(
		id: string,
		name: ToolName,
		partialArgs: Record<string, any>,
		partial: boolean,
		originalName?: string,
	): ToolUse | null {
		// Build stringified params for display/partial-progress UI.
		// NOTE: For streaming partial updates, we MUST populate params even for complex types
		// because tool.handlePartial() methods rely on params to show UI updates.
		const params: Partial<Record<ToolParamName, string>> = {}

		// Allow private LM tool params through as well (they aren't in toolParamNames).
		const isExternalTool = isPrivateLmTool(name)

		for (const [key, value] of Object.entries(partialArgs)) {
			if (toolParamNames.includes(key as ToolParamName) || isExternalTool) {
				params[key as ToolParamName] = typeof value === "string" ? value : JSON.stringify(value)
			}
		}

		// Build partial nativeArgs based on what we have so far
		let nativeArgs: any = undefined

		// Track if legacy format was used (for telemetry)
		let usedLegacyFormat = false

		switch (name) {
			case "read_file":
				// Check for legacy format first: { files: [...] }
				// Handle both array and stringified array (some models double-stringify)
				if (partialArgs.files !== undefined) {
					let filesArray: unknown[] | null = null

					if (Array.isArray(partialArgs.files)) {
						filesArray = partialArgs.files
					} else if (typeof partialArgs.files === "string") {
						// Handle double-stringified case: files is a string containing JSON array
						try {
							const parsed = JSON.parse(partialArgs.files)
							if (Array.isArray(parsed)) {
								filesArray = parsed
							}
						} catch {
							// Not valid JSON, ignore
						}
					}

					if (filesArray && filesArray.length > 0) {
						usedLegacyFormat = true
						nativeArgs = {
							files: this.convertFileEntries(filesArray),
							_legacyFormat: true as const,
						}
					}
				}
				// New format: { path: "...", mode: "..." }
				// Accept filePath as alias for path (models sometimes hallucinate filePath for read_file)
				if (!nativeArgs && (partialArgs.path !== undefined || partialArgs.filePath !== undefined)) {
					nativeArgs = {
						path: partialArgs.path ?? partialArgs.filePath,
						mode: partialArgs.mode,
						offset: this.coerceOptionalNumber(partialArgs.offset),
						limit: this.coerceOptionalNumber(partialArgs.limit),
						indentation:
							partialArgs.indentation && typeof partialArgs.indentation === "object"
								? {
										anchor_line: this.coerceOptionalNumber(partialArgs.indentation.anchor_line),
										max_levels: this.coerceOptionalNumber(partialArgs.indentation.max_levels),
										max_lines: this.coerceOptionalNumber(partialArgs.indentation.max_lines),
										include_siblings: this.coerceOptionalBoolean(
											partialArgs.indentation.include_siblings,
										),
										include_header: this.coerceOptionalBoolean(
											partialArgs.indentation.include_header,
										),
									}
								: undefined,
					}
				}
				break

			case "attempt_completion":
				if (partialArgs.result) {
					nativeArgs = {
						result: partialArgs.result,
						rating: partialArgs.rating,
						feedback: partialArgs.feedback,
					}
				}
				break

			case "wait_for_message":
				// Both params optional — always emit nativeArgs so the dispatcher
				// does not reject the call as "missing nativeArgs".
				nativeArgs = {
					rating: partialArgs.rating,
					reason: partialArgs.reason,
				}
				break

			case "execute_command":
				if (partialArgs.command) {
					nativeArgs = {
						command: partialArgs.command,
						cwd: partialArgs.cwd,
						timeout: partialArgs.timeout,
					}
				}
				break

			case "write_to_file":
				if (partialArgs.path || partialArgs.filePath || partialArgs.content) {
					nativeArgs = {
						path: partialArgs.path ?? partialArgs.filePath,
						content: partialArgs.content,
					}
				}
				break

			case "ask_followup_question":
				if (
					partialArgs.question !== undefined ||
					partialArgs.follow_up !== undefined ||
					partialArgs.form !== undefined
				) {
					nativeArgs = {
						question: partialArgs.question,
						follow_up: Array.isArray(partialArgs.follow_up) ? partialArgs.follow_up : undefined,
						form: Array.isArray(partialArgs.form) ? partialArgs.form : undefined,
					}
				}
				break

			case "ask_live_memory":
				if (partialArgs.question !== undefined) {
					nativeArgs = {
						question: partialArgs.question,
						contextFiles: Array.isArray(partialArgs.contextFiles) ? partialArgs.contextFiles : undefined,
						timeoutMs: this.coerceOptionalNumber(partialArgs.timeoutMs),
						softTimeoutSec: this.coerceOptionalNumber(partialArgs.softTimeoutSec),
						softResultLength: this.coerceOptionalNumber(partialArgs.softResultLength),
					}
				}
				break

			case "apply_diff":
				if (
					partialArgs.path !== undefined ||
					partialArgs.filePath !== undefined ||
					partialArgs.diff !== undefined
				) {
					let path = (partialArgs.path ?? partialArgs.filePath) as string | undefined
					let diff = partialArgs.diff as string | undefined

					// Recovery: same XML-leak pattern can occur during streaming too.
					if (path === undefined && diff !== undefined) {
						const recovered = this.extractPathFromXMLLeak(diff)
						if (recovered) {
							path = recovered.path
							diff = recovered.sanitized
						}
					}

					nativeArgs = {
						path,
						diff,
					}
				}
				break

			case "rag_search":
				if (partialArgs.query !== undefined) {
					nativeArgs = {
						query: partialArgs.query,
						path: partialArgs.path,
						maxResults: this.coerceOptionalNumber(partialArgs.maxResults),
					}
				}
				break

			case "git_search":
				if (partialArgs.query !== undefined) {
					nativeArgs = {
						query: partialArgs.query,
						maxResults: this.coerceOptionalNumber(partialArgs.maxResults),
						since: partialArgs.since,
						until: partialArgs.until,
					}
				}
				break

			case "generate_image":
				if (partialArgs.prompt !== undefined || partialArgs.path !== undefined) {
					nativeArgs = {
						prompt: partialArgs.prompt,
						path: partialArgs.path,
						image: partialArgs.image,
					}
				}
				break

			case "run_slash_command":
				if (partialArgs.command !== undefined) {
					nativeArgs = {
						command: partialArgs.command,
						args: partialArgs.args,
					}
				}
				break

			case "skills":
				if (partialArgs.skill !== undefined) {
					nativeArgs = {
						skill: partialArgs.skill,
						args: partialArgs.args,
					}
				}
				break

			case "grep_search":
				if (
					partialArgs.path !== undefined ||
					partialArgs.query !== undefined ||
					partialArgs.pattern !== undefined
				) {
					nativeArgs = {
						path: partialArgs.path,
						query: partialArgs.query ?? partialArgs.pattern,
						fileTypes: partialArgs.fileTypes ?? partialArgs.file_pattern,
						excludePattern: partialArgs.excludePattern,
						isRegex: this.coerceOptionalBoolean(partialArgs.isRegex ?? partialArgs.regex),
						caseSensitive: this.coerceOptionalBoolean(partialArgs.caseSensitive),
						wholeWord: this.coerceOptionalBoolean(partialArgs.wholeWord),
						maxResults: this.coerceOptionalNumber(partialArgs.maxResults),
						contextBefore: this.coerceOptionalNumber(partialArgs.contextBefore),
						contextAfter: this.coerceOptionalNumber(partialArgs.contextAfter),
					}
				}
				break

			case "switch_mode":
				if (partialArgs.mode_slug !== undefined || partialArgs.reason !== undefined) {
					nativeArgs = {
						mode_slug: partialArgs.mode_slug,
						reason: partialArgs.reason,
						task_id: partialArgs.task_id,
					}
				}
				break

			case "update_todo_list":
				if (partialArgs.todos !== undefined) {
					nativeArgs = {
						todos: partialArgs.todos,
					}
				}
				break

			case "set_task_title":
				if (partialArgs.title !== undefined) {
					nativeArgs = {
						title: partialArgs.title,
					}
				}
				break

			case "give_feedback":
				if (partialArgs.feedback !== undefined) {
					nativeArgs = {
						feedback: partialArgs.feedback,
					}
				}
				break

			case "use_mcp_tool":
				if (partialArgs.server_name !== undefined || partialArgs.tool_name !== undefined) {
					nativeArgs = {
						server_name: partialArgs.server_name,
						tool_name: partialArgs.tool_name,
						arguments: partialArgs.arguments,
					}
				}
				break

			case "access_mcp_resource":
				if (partialArgs.server_name !== undefined || partialArgs.uri !== undefined) {
					nativeArgs = {
						server_name: partialArgs.server_name,
						uri: partialArgs.uri,
					}
				}
				break

			case "call_mcp_tool_async":
				if (partialArgs.server_name !== undefined || partialArgs.tool_name !== undefined) {
					nativeArgs = {
						server_name: partialArgs.server_name,
						tool_name: partialArgs.tool_name,
						arguments: partialArgs.arguments,
						source:
							partialArgs.source === "project" || partialArgs.source === "global"
								? partialArgs.source
								: undefined,
					}
				}
				break

			case "check_mcp_call_status":
				if (partialArgs.call_id !== undefined) {
					nativeArgs = {
						call_id: partialArgs.call_id,
					}
				}
				break

			case "wait_for_mcp_call":
				if (partialArgs.call_ids !== undefined) {
					nativeArgs = {
						call_ids: Array.isArray(partialArgs.call_ids) ? partialArgs.call_ids : [partialArgs.call_ids],
						wait: partialArgs.wait === "any" ? "any" : "all",
						timeout: this.coerceOptionalNumber(partialArgs.timeout),
					}
				}
				break

			case "apply_patch":
				if (partialArgs.patch !== undefined) {
					nativeArgs = {
						patch: partialArgs.patch,
					}
				}
				break

			case "search_replace":
				if (
					partialArgs.file_path !== undefined ||
					partialArgs.old_string !== undefined ||
					partialArgs.new_string !== undefined
				) {
					nativeArgs = {
						file_path: partialArgs.file_path,
						old_string: partialArgs.old_string,
						new_string: partialArgs.new_string,
					}
				}
				break

			case "edit":
			case "search_and_replace":
				if (
					partialArgs.file_path !== undefined ||
					partialArgs.old_string !== undefined ||
					partialArgs.new_string !== undefined
				) {
					nativeArgs = {
						file_path: partialArgs.file_path,
						old_string: partialArgs.old_string,
						new_string: partialArgs.new_string,
						replace_all: this.coerceOptionalBoolean(partialArgs.replace_all),
					}
				}
				break

			case "edit_file":
				if (
					partialArgs.file_path !== undefined ||
					partialArgs.old_string !== undefined ||
					partialArgs.new_string !== undefined
				) {
					nativeArgs = {
						file_path: partialArgs.file_path,
						old_string: partialArgs.old_string,
						new_string: partialArgs.new_string,
						expected_replacements: partialArgs.expected_replacements,
					}
				}
				break

			case "list_files":
				if (partialArgs.path !== undefined || partialArgs.filePath !== undefined) {
					nativeArgs = {
						path: partialArgs.path ?? partialArgs.filePath,
						recursive: this.coerceOptionalBoolean(partialArgs.recursive),
					}
				}
				break

			case "new_task":
				if (partialArgs.mode !== undefined || partialArgs.message !== undefined) {
					nativeArgs = {
						mode: partialArgs.mode,
						message: partialArgs.message,
						todos: partialArgs.todos,
						is_background: this.coerceOptionalBoolean(partialArgs.is_background),
						softResultLength: this.coerceOptionalNumber(partialArgs.softResultLength),
						softTimeoutSec: this.coerceOptionalNumber(partialArgs.softTimeoutSec),
						peer_task_ids: Array.isArray(partialArgs.peer_task_ids) ? partialArgs.peer_task_ids : undefined,
						title: partialArgs.title,
					}
				}
				break

			case "wait_for_task":
				if (partialArgs.task_ids !== undefined) {
					nativeArgs = {
						task_ids: Array.isArray(partialArgs.task_ids) ? partialArgs.task_ids : [partialArgs.task_ids],
						wait: partialArgs.wait === "any" ? "any" : "all",
						timeout: this.coerceOptionalNumber(partialArgs.timeout),
					}
				}
				break

			case "check_task_status":
				if (partialArgs.task_id !== undefined) {
					nativeArgs = {
						task_id: partialArgs.task_id,
						include_activity: this.coerceOptionalBoolean(partialArgs.include_activity),
					}
				}
				break

			case "cancel_tasks":
				if (partialArgs.task_ids !== undefined) {
					nativeArgs = {
						task_ids: Array.isArray(partialArgs.task_ids) ? partialArgs.task_ids : [partialArgs.task_ids],
					}
				}
				break

			case "answer_subtask_question":
				if (partialArgs.task_id !== undefined || partialArgs.answer !== undefined) {
					nativeArgs = {
						task_id: partialArgs.task_id,
						answer: partialArgs.answer,
					}
				}
				break

			case "list_background_tasks":
				nativeArgs = {
					scope: partialArgs.scope === "peers" ? "peers" : "children",
				}
				break

			case "create_directory":
				if (partialArgs.path !== undefined || partialArgs.filePath !== undefined) {
					nativeArgs = {
						path: partialArgs.path ?? partialArgs.filePath,
					}
				}
				break

			case "create_new_workspace":
				if (
					partialArgs.path !== undefined ||
					partialArgs.filePath !== undefined ||
					partialArgs.name !== undefined
				) {
					nativeArgs = {
						path: partialArgs.path ?? partialArgs.filePath,
						name: partialArgs.name,
						folders: partialArgs.folders,
						openInNewWindow: this.coerceOptionalBoolean(partialArgs.openInNewWindow),
					}
				}
				break

			case "file":
				if (
					partialArgs.subcommand !== undefined ||
					partialArgs.path !== undefined ||
					partialArgs.filePath !== undefined
				) {
					nativeArgs = {
						subcommand: partialArgs.subcommand,
						path: partialArgs.path ?? partialArgs.filePath,
						destination: partialArgs.destination,
						recursive: this.coerceOptionalBoolean(partialArgs.recursive),
					}
				}
				break

			case "fetch_web_page":
				if (partialArgs.urls !== undefined) {
					nativeArgs = {
						urls: partialArgs.urls,
						query: partialArgs.query,
					}
				}
				break

			case "find_files":
				if (partialArgs.pattern !== undefined) {
					nativeArgs = {
						pattern: partialArgs.pattern,
						maxResults: this.coerceOptionalNumber(partialArgs.maxResults),
					}
				}
				break

			case "get_errors":
				nativeArgs = {
					filePaths: partialArgs.filePaths,
				}
				break

			case "get_changed_files":
				nativeArgs = {}
				break

			case "get_project_setup_info":
				nativeArgs = {}
				break

				break

			case "insert_edit":
				if (
					partialArgs.path !== undefined ||
					partialArgs.filePath !== undefined ||
					partialArgs.line !== undefined
				) {
					nativeArgs = {
						path: partialArgs.path ?? partialArgs.filePath,
						filePath: partialArgs.filePath,
						line: this.coerceOptionalNumber(partialArgs.line)!,
						column: this.coerceOptionalNumber(partialArgs.column),
						text: partialArgs.text,
					}
				}
				break

			case "list_code_usages":
				if (partialArgs.path !== undefined || partialArgs.filePath !== undefined) {
					nativeArgs = {
						path: partialArgs.path ?? partialArgs.filePath,
						filePath: partialArgs.filePath,
						line: this.coerceOptionalNumber(partialArgs.line)!,
						column: this.coerceOptionalNumber(partialArgs.column)!,
					}
				}
				break

			case "read_project_structure":
				nativeArgs = {
					maxDepth: this.coerceOptionalNumber(partialArgs.maxDepth),
					includeHidden: this.coerceOptionalBoolean(partialArgs.includeHidden),
				}
				break

			case "rename_symbol":
				if (partialArgs.path !== undefined || partialArgs.filePath !== undefined) {
					nativeArgs = {
						path: partialArgs.path ?? partialArgs.filePath,
						filePath: partialArgs.filePath,
						line: this.coerceOptionalNumber(partialArgs.line)!,
						column: this.coerceOptionalNumber(partialArgs.column)!,
						newName: partialArgs.newName,
					}
				}
				break

			case "view_image":
				if (partialArgs.path !== undefined || partialArgs.filePath !== undefined) {
					nativeArgs = {
						path: partialArgs.path ?? partialArgs.filePath,
						filePath: partialArgs.filePath,
					}
				}
				break

			case "lsp_search":
				if (partialArgs.query !== undefined) {
					nativeArgs = {
						query: partialArgs.query,
						maxResults: this.coerceOptionalNumber(partialArgs.maxResults),
					}
				}
				break

			case "read_command_output":
				if (partialArgs.artifact_id !== undefined) {
					nativeArgs = {
						artifact_id: partialArgs.artifact_id,
						search: partialArgs.search,
						offset: this.coerceOptionalNumber(partialArgs.offset),
						limit: this.coerceOptionalNumber(partialArgs.limit),
					}
				}
				break

			case "sed":
				if (partialArgs.path !== undefined || partialArgs.filePath !== undefined) {
					nativeArgs = {
						path: partialArgs.path ?? partialArgs.filePath,
						pattern: partialArgs.pattern,
						replacement: partialArgs.replacement,
						isRegex: this.coerceOptionalBoolean(partialArgs.isRegex),
						global: this.coerceOptionalBoolean(partialArgs.global),
					}
				}
				break

			case "sleep":
				if (partialArgs.seconds !== undefined) {
					nativeArgs = {
						seconds: this.coerceOptionalNumber(partialArgs.seconds)!,
					}
				}
				break

			case "send_message_to_task":
				if (partialArgs.task_id !== undefined || partialArgs.message !== undefined) {
					nativeArgs = {
						task_id: partialArgs.task_id,
						message: partialArgs.message,
						wait: this.coerceOptionalBoolean(partialArgs.wait),
						timeout_sec: this.coerceOptionalNumber(partialArgs.timeout_sec),
					}
				}
				break

			default:
				if (isPrivateLmTool(name)) {
					// Private LM tools: pass partial args through as nativeArgs
					// so the tool handler can process them once the call is complete.
					nativeArgs = partialArgs
				}
				break
		}

		const result: ToolUse = {
			type: "tool_use" as const,
			name,
			params,
			partial,
			nativeArgs,
		}

		// Preserve original name for API history when an alias was used
		if (originalName) {
			result.originalName = originalName
		}

		// Track legacy format usage for telemetry
		if (usedLegacyFormat) {
			result.usedLegacyFormat = true
		}

		return result
	}

	/**
	 * Convert a native tool call chunk to a ToolUse object.
	 *
	 * @param toolCall - The native tool call from the API stream
	 * @returns A properly typed ToolUse object
	 */
	public static parseToolCall<TName extends ToolName>(toolCall: {
		id: string
		name: TName
		arguments: string
	}): ToolUse<TName> | McpToolUse | null {
		// Check if this is a dynamic MCP tool (mcp--serverName--toolName)
		// Also handle models that output underscores instead of hyphens (mcp__serverName__toolName)
		const mcpPrefix = MCP_TOOL_PREFIX + MCP_TOOL_SEPARATOR

		if (typeof toolCall.name === "string") {
			// Normalize the tool name to handle models that output underscores instead of hyphens
			const normalizedName = normalizeMcpToolName(toolCall.name)
			if (normalizedName.startsWith(mcpPrefix)) {
				// Pass the original tool call but with normalized name for parsing
				return this.parseDynamicMcpTool({ ...toolCall, name: normalizedName })
			}
		}

		// Resolve tool alias to canonical name
		const resolvedName = resolveToolAlias(toolCall.name as string) as TName

		// Validate tool name (after alias resolution).
		// Private provider tools are discovered at build time and filtered by mode;
		// allow them through.
		if (
			!toolNames.includes(resolvedName as ToolName) &&
			!customToolRegistry.has(resolvedName) &&
			!isPrivateLmTool(resolvedName)
		) {
			// Compute the closest known tool name via simple Levenshtein
			// distance so we can suggest a correction in the error feedback.
			// Skip private/external tool names — suggest only native tools.
			const suggestion = findClosestToolName(
				resolvedName as string,
				toolNames.filter((t) => !t.startsWith("mcp")),
			)
			const hint = suggestion ? ` Did you mean '${suggestion}'?` : ""
			this.lastParseError =
				`Unknown tool '${resolvedName}'.` +
				hint +
				` Available tools: ${toolNames
					.filter((t) => !t.startsWith("mcp"))
					.sort()
					.join(", ")}.`

			webviewLog.error(`Invalid tool name: ${toolCall.name} (resolved: ${resolvedName})`)
			webviewLog.error(`Valid tool names:`, toolNames)
			return null
		}

		try {
			// Parse the arguments JSON string
			const args = toolCall.arguments === "" ? {} : JSON.parse(toolCall.arguments)
			this.normalizeArgAliases(args)

			// Build stringified params for display/logging.
			// Tool execution MUST use nativeArgs (typed) and does not support legacy fallbacks.
			const params: Partial<Record<ToolParamName, string>> = {}

			for (const [key, value] of Object.entries(args)) {
				// Validate parameter name — skip for external LM tools whose
				// parameter schemas are defined by the registering extension.
				if (
					!toolParamNames.includes(key as ToolParamName) &&
					!customToolRegistry.has(resolvedName) &&
					!isPrivateLmTool(resolvedName)
				) {
					webviewLog.warn(
						`Unknown parameter '${key}' for tool '${resolvedName}' (check the tool schema for valid params)`,
					)
					continue
				}

				// Convert to string for legacy params format
				const stringValue = typeof value === "string" ? value : JSON.stringify(value)
				params[key as ToolParamName] = stringValue
			}

			// Build typed nativeArgs for tool execution.
			// Each case validates the minimum required parameters and constructs a properly typed
			// nativeArgs object. If validation fails, we treat the tool call as invalid and fail fast.
			let nativeArgs: NativeArgsFor<TName> | undefined = undefined

			// Track if legacy format was used (for telemetry)
			let usedLegacyFormat = false

			switch (resolvedName) {
				case "read_file":
					// Check for legacy format first: { files: [...] }
					// Handle both array and stringified array (some models double-stringify)
					if (args.files !== undefined) {
						let filesArray: unknown[] | null = null

						if (Array.isArray(args.files)) {
							filesArray = args.files
						} else if (typeof args.files === "string") {
							// Handle double-stringified case: files is a string containing JSON array
							try {
								const parsed = JSON.parse(args.files)
								if (Array.isArray(parsed)) {
									filesArray = parsed
								}
							} catch {
								// Not valid JSON, ignore
							}
						}

						if (filesArray && filesArray.length > 0) {
							usedLegacyFormat = true
							nativeArgs = {
								files: this.convertFileEntries(filesArray),
								_legacyFormat: true as const,
							} as NativeArgsFor<TName>
						}
					}
					// New format: { path: "...", mode: "..." }
					// Accept filePath as alias for path (models sometimes hallucinate filePath for read_file)
					if (!nativeArgs && (args.path !== undefined || args.filePath !== undefined)) {
						nativeArgs = {
							path: args.path ?? args.filePath,
							mode: args.mode,
							offset: this.coerceOptionalNumber(args.offset),
							limit: this.coerceOptionalNumber(args.limit),
							indentation:
								args.indentation && typeof args.indentation === "object"
									? {
											anchor_line: this.coerceOptionalNumber(args.indentation.anchor_line),
											max_levels: this.coerceOptionalNumber(args.indentation.max_levels),
											max_lines: this.coerceOptionalNumber(args.indentation.max_lines),
											include_siblings: this.coerceOptionalBoolean(
												args.indentation.include_siblings,
											),
											include_header: this.coerceOptionalBoolean(args.indentation.include_header),
										}
									: undefined,
						} as NativeArgsFor<TName>
					}
					break

				case "attempt_completion":
					if (args.result) {
						nativeArgs = {
							result: args.result,
							rating: args.rating,
							feedback: args.feedback,
						} as NativeArgsFor<TName>
					}
					break

				case "wait_for_message":
					// Both params optional — always emit nativeArgs so the dispatcher
					// does not reject the call as "missing nativeArgs".
					nativeArgs = {
						rating: args.rating,
						reason: args.reason,
					} as NativeArgsFor<TName>
					break

				case "execute_command":
					if (args.command) {
						nativeArgs = {
							command: args.command,
							cwd: args.cwd,
							timeout: args.timeout,
						} as NativeArgsFor<TName>
					}
					break

				case "apply_diff":
					if (args.diff !== undefined) {
						let path = args.path ?? (args.filePath as string | undefined)
						let diff = args.diff as string

						// Recovery: some vscode-lm models leak <parameter name="path"> XML tags
						// into the `diff` string value instead of emitting `path` as a
						// separate JSON key.  If `path` is missing, attempt to extract it
						// from the `diff` suffix before failing.
						if (path === undefined) {
							const recovered = this.extractPathFromXMLLeak(diff)
							if (recovered) {
								path = recovered.path
								diff = recovered.sanitized
								webviewLog.warn(
									`[NativeToolCallParser] Recovered apply_diff path "${path}" from malformed diff suffix (vscode-lm XML leak).`,
								)
							}
						}

						if (path !== undefined) {
							nativeArgs = {
								path,
								diff,
							} as NativeArgsFor<TName>
						}
					}
					break

				case "edit":
				case "search_and_replace":
					if (
						args.file_path !== undefined &&
						args.old_string !== undefined &&
						args.new_string !== undefined
					) {
						nativeArgs = {
							file_path: args.file_path,
							old_string: args.old_string,
							new_string: args.new_string,
							replace_all: this.coerceOptionalBoolean(args.replace_all),
						} as NativeArgsFor<TName>
					}
					break

				case "ask_followup_question":
					// follow_up and form are each optional (provide either); a form
					// presents typed input widgets. Build nativeArgs when the question
					// plus at least one answer channel is present. Passing form through
					// is required — omitting it drops the widgets and the handler reports
					// a missing follow_up.
					if (args.question !== undefined && (args.follow_up !== undefined || args.form !== undefined)) {
						nativeArgs = {
							question: args.question,
							follow_up: args.follow_up,
							form: args.form,
						} as NativeArgsFor<TName>
					}
					break

				case "ask_live_memory":
					if (args.question !== undefined) {
						nativeArgs = {
							question: args.question,
							contextFiles: Array.isArray(args.contextFiles) ? args.contextFiles : undefined,
							timeoutMs: this.coerceOptionalNumber(args.timeoutMs),
							softTimeoutSec: this.coerceOptionalNumber(args.softTimeoutSec),
							softResultLength: this.coerceOptionalNumber(args.softResultLength),
						} as NativeArgsFor<TName>
					}
					break

				case "rag_search":
					if (args.query !== undefined) {
						nativeArgs = {
							query: args.query,
							path: args.path,
							maxResults: this.coerceOptionalNumber(args.maxResults),
						} as NativeArgsFor<TName>
					}
					break

				case "git_search":
					if (args.query !== undefined) {
						nativeArgs = {
							query: args.query,
							maxResults: this.coerceOptionalNumber(args.maxResults),
							since: args.since,
							until: args.until,
						} as NativeArgsFor<TName>
					}
					break

				case "generate_image":
					if (args.prompt !== undefined && args.path !== undefined) {
						nativeArgs = {
							prompt: args.prompt,
							path: args.path,
							image: args.image,
						} as NativeArgsFor<TName>
					}
					break

				case "run_slash_command":
					if (args.command !== undefined) {
						nativeArgs = {
							command: args.command,
							args: args.args,
						} as NativeArgsFor<TName>
					}
					break

				case "skills":
					if (args.skill !== undefined) {
						nativeArgs = {
							skill: args.skill,
							args: args.args,
						} as NativeArgsFor<TName>
					}
					break

				case "grep_search":
					if (args.path !== undefined && (args.query !== undefined || args.pattern !== undefined)) {
						nativeArgs = {
							path: args.path,
							query: args.query ?? args.pattern,
							fileTypes: args.fileTypes ?? args.file_pattern,
							excludePattern: args.excludePattern,
							isRegex: this.coerceOptionalBoolean(args.isRegex ?? args.regex) ?? true,
							caseSensitive: this.coerceOptionalBoolean(args.caseSensitive) ?? false,
							wholeWord: this.coerceOptionalBoolean(args.wholeWord) ?? false,
							maxResults: this.coerceOptionalNumber(args.maxResults),
							contextBefore: this.coerceOptionalNumber(args.contextBefore),
							contextAfter: this.coerceOptionalNumber(args.contextAfter),
						} as NativeArgsFor<TName>
					}
					break

				case "switch_mode":
					if (args.mode_slug !== undefined && args.reason !== undefined) {
						nativeArgs = {
							mode_slug: args.mode_slug,
							reason: args.reason,
							task_id: args.task_id,
						} as NativeArgsFor<TName>
					}
					break

				case "update_todo_list":
					if (args.todos !== undefined) {
						nativeArgs = {
							todos: args.todos,
						} as NativeArgsFor<TName>
					}
					break

				case "set_task_title":
					if (args.title !== undefined) {
						nativeArgs = {
							title: args.title,
						} as NativeArgsFor<TName>
					}
					break

				case "give_feedback":
					if (args.feedback !== undefined) {
						nativeArgs = {
							feedback: args.feedback,
						} as NativeArgsFor<TName>
					}
					break

				case "read_command_output":
					if (args.artifact_id !== undefined) {
						nativeArgs = {
							artifact_id: args.artifact_id,
							search: args.search,
							offset: args.offset,
							limit: args.limit,
						} as NativeArgsFor<TName>
					}
					break

				case "write_to_file":
					if ((args.path !== undefined || args.filePath !== undefined) && args.content !== undefined) {
						nativeArgs = {
							path: args.path ?? args.filePath,
							content: args.content,
						} as NativeArgsFor<TName>
					}
					break

				case "use_mcp_tool":
					if (args.server_name !== undefined && args.tool_name !== undefined) {
						nativeArgs = {
							server_name: args.server_name,
							tool_name: args.tool_name,
							arguments: args.arguments,
						} as NativeArgsFor<TName>
					}
					break

				case "access_mcp_resource":
					if (args.server_name !== undefined && args.uri !== undefined) {
						nativeArgs = {
							server_name: args.server_name,
							uri: args.uri,
						} as NativeArgsFor<TName>
					}
					break

				case "call_mcp_tool_async":
					if (args.server_name !== undefined && args.tool_name !== undefined) {
						nativeArgs = {
							server_name: args.server_name,
							tool_name: args.tool_name,
							arguments: args.arguments,
							source: args.source === "project" || args.source === "global" ? args.source : undefined,
						} as NativeArgsFor<TName>
					}
					break

				case "check_mcp_call_status":
					if (args.call_id !== undefined) {
						nativeArgs = {
							call_id: args.call_id,
						} as NativeArgsFor<TName>
					}
					break

				case "wait_for_mcp_call":
					if (args.call_ids !== undefined) {
						nativeArgs = {
							call_ids: Array.isArray(args.call_ids) ? args.call_ids : [args.call_ids],
							wait: args.wait === "any" ? "any" : "all",
							timeout: this.coerceOptionalNumber(args.timeout),
						} as NativeArgsFor<TName>
					}
					break

				case "apply_patch":
					if (args.patch !== undefined) {
						nativeArgs = {
							patch: args.patch,
						} as NativeArgsFor<TName>
					}
					break

				case "search_replace":
					if (
						args.file_path !== undefined &&
						args.old_string !== undefined &&
						args.new_string !== undefined
					) {
						nativeArgs = {
							file_path: args.file_path,
							old_string: args.old_string,
							new_string: args.new_string,
						} as NativeArgsFor<TName>
					}
					break

				case "edit_file":
					if (
						args.file_path !== undefined &&
						args.old_string !== undefined &&
						args.new_string !== undefined
					) {
						nativeArgs = {
							file_path: args.file_path,
							old_string: args.old_string,
							new_string: args.new_string,
							expected_replacements: args.expected_replacements,
						} as NativeArgsFor<TName>
					}
					break

				case "list_files":
					if (args.path !== undefined || args.filePath !== undefined) {
						nativeArgs = {
							path: args.path ?? args.filePath,
							recursive: this.coerceOptionalBoolean(args.recursive),
						} as NativeArgsFor<TName>
					}
					break

				case "new_task":
					if (args.mode !== undefined && args.message !== undefined) {
						nativeArgs = {
							mode: args.mode,
							message: args.message,
							todos: args.todos,
							is_background: this.coerceOptionalBoolean(args.is_background),
							softResultLength: this.coerceOptionalNumber(args.softResultLength),
							softTimeoutSec: this.coerceOptionalNumber(args.softTimeoutSec),
							peer_task_ids: Array.isArray(args.peer_task_ids) ? args.peer_task_ids : undefined,
							title: args.title,
						} as NativeArgsFor<TName>
					}
					break

				case "wait_for_task":
					if (args.task_ids !== undefined) {
						nativeArgs = {
							task_ids: Array.isArray(args.task_ids) ? args.task_ids : [args.task_ids],
							wait: args.wait === "any" ? "any" : "all",
							timeout: this.coerceOptionalNumber(args.timeout),
						} as NativeArgsFor<TName>
					}
					break

				case "check_task_status":
					if (args.task_id !== undefined) {
						nativeArgs = {
							task_id: args.task_id,
							include_activity: this.coerceOptionalBoolean(args.include_activity),
						} as NativeArgsFor<TName>
					}
					break

				case "cancel_tasks":
					if (args.task_ids !== undefined) {
						nativeArgs = {
							task_ids: Array.isArray(args.task_ids) ? args.task_ids : [args.task_ids],
						} as NativeArgsFor<TName>
					}
					break

				case "answer_subtask_question":
					if (args.task_id !== undefined && args.answer !== undefined) {
						nativeArgs = {
							task_id: args.task_id,
							answer: args.answer,
						} as NativeArgsFor<TName>
					}
					break

				case "list_background_tasks":
					nativeArgs = {
						scope: args.scope === "peers" ? "peers" : "children",
					} as NativeArgsFor<TName>
					break

				case "create_directory":
					if (args.path !== undefined || args.filePath !== undefined) {
						nativeArgs = {
							path: args.path ?? args.filePath,
						} as NativeArgsFor<TName>
					}
					break

				case "create_new_workspace":
					if ((args.path !== undefined || args.filePath !== undefined) && args.name !== undefined) {
						nativeArgs = {
							path: args.path ?? args.filePath,
							name: args.name,
							folders: args.folders,
							openInNewWindow: this.coerceOptionalBoolean(args.openInNewWindow),
						} as NativeArgsFor<TName>
					}
					break

				case "file":
					if (args.subcommand !== undefined && (args.path !== undefined || args.filePath !== undefined)) {
						nativeArgs = {
							subcommand: args.subcommand,
							path: args.path ?? args.filePath,
							destination: args.destination,
							recursive: this.coerceOptionalBoolean(args.recursive),
						} as NativeArgsFor<TName>
					}
					break

				case "fetch_web_page":
					if (args.urls !== undefined) {
						nativeArgs = {
							urls: args.urls,
							query: args.query,
						} as NativeArgsFor<TName>
					}
					break

				case "find_files":
					if (args.pattern !== undefined) {
						nativeArgs = {
							pattern: args.pattern,
							maxResults: this.coerceOptionalNumber(args.maxResults),
						} as NativeArgsFor<TName>
					}
					break

				case "get_errors":
					nativeArgs = {
						filePaths: args.filePaths,
					} as NativeArgsFor<TName>
					break

				case "get_changed_files":
					nativeArgs = {} as NativeArgsFor<TName>
					break

				case "get_project_setup_info":
					nativeArgs = {} as NativeArgsFor<TName>
					break

					break

				case "insert_edit":
					if (
						(args.path !== undefined || args.filePath !== undefined) &&
						args.line !== undefined &&
						args.text !== undefined
					) {
						nativeArgs = {
							path: args.path ?? args.filePath,
							filePath: args.filePath,
							line: this.coerceOptionalNumber(args.line)!,
							column: this.coerceOptionalNumber(args.column),
							text: args.text,
						} as NativeArgsFor<TName>
					}
					break

				case "list_code_usages":
					if (
						(args.path !== undefined || args.filePath !== undefined) &&
						args.line !== undefined &&
						args.column !== undefined
					) {
						nativeArgs = {
							path: args.path ?? args.filePath,
							filePath: args.filePath,
							line: this.coerceOptionalNumber(args.line)!,
							column: this.coerceOptionalNumber(args.column)!,
						} as NativeArgsFor<TName>
					}
					break

				case "read_project_structure":
					nativeArgs = {
						maxDepth: this.coerceOptionalNumber(args.maxDepth),
						includeHidden: this.coerceOptionalBoolean(args.includeHidden),
					} as NativeArgsFor<TName>
					break

				case "rename_symbol":
					if (
						(args.path !== undefined || args.filePath !== undefined) &&
						args.line !== undefined &&
						args.column !== undefined &&
						args.newName !== undefined
					) {
						nativeArgs = {
							path: args.path ?? args.filePath,
							filePath: args.filePath,
							line: this.coerceOptionalNumber(args.line)!,
							column: this.coerceOptionalNumber(args.column)!,
							newName: args.newName,
						} as NativeArgsFor<TName>
					}
					break

				case "view_image":
					if (args.path !== undefined || args.filePath !== undefined) {
						nativeArgs = {
							path: args.path ?? args.filePath,
							filePath: args.filePath,
						} as NativeArgsFor<TName>
					}
					break

				case "lsp_search":
					if (args.query !== undefined) {
						nativeArgs = {
							query: args.query,
							maxResults: this.coerceOptionalNumber(args.maxResults),
						} as NativeArgsFor<TName>
					}
					break

				case "sleep":
					if (args.seconds !== undefined) {
						nativeArgs = {
							seconds: this.coerceOptionalNumber(args.seconds)!,
						} as NativeArgsFor<TName>
					}
					break

				case "send_message_to_task":
					if (args.task_id !== undefined && args.message !== undefined) {
						nativeArgs = {
							task_id: args.task_id,
							message: args.message,
							wait: this.coerceOptionalBoolean(args.wait),
							timeout_sec: this.coerceOptionalNumber(args.timeout_sec),
						} as NativeArgsFor<TName>
					}
					break

				case "sed":
					if (
						(args.path !== undefined || args.filePath !== undefined) &&
						args.pattern !== undefined &&
						args.replacement !== undefined
					) {
						nativeArgs = {
							path: args.path ?? args.filePath,
							pattern: args.pattern,
							replacement: args.replacement,
							isRegex: this.coerceOptionalBoolean(args.isRegex),
							global: this.coerceOptionalBoolean(args.global),
						} as NativeArgsFor<TName>
					}
					break

				default:
					if (customToolRegistry.has(resolvedName)) {
						nativeArgs = args as NativeArgsFor<TName>
					} else if (isPrivateLmTool(resolvedName)) {
						// External LM tools: pass raw arguments through.
						// The actual schema validation is handled by the tool's
						// registered inputSchema when invoked via vscode.lm.invokeTool.
						nativeArgs = args as NativeArgsFor<TName>
					}

					break
			}

			// Native-only: core tools must always have typed nativeArgs.
			// External tools pass raw args and are validated by the tool's own schema.
			// If we couldn't construct it, the model produced an invalid tool call payload.
			if (!nativeArgs && !customToolRegistry.has(resolvedName) && !isPrivateLmTool(resolvedName)) {
				// Identify which required fields are missing so the model can fix the call.
				const missingFields = this.missingRequiredFields(resolvedName, args)
				const receivedSnippet = JSON.stringify(args).slice(0, 500)
				throw new Error(
					`[NativeToolCallParser] Invalid arguments for tool '${resolvedName}'. ` +
						`Native tool calls require a valid JSON payload matching the tool schema. ` +
						(missingFields.length > 0 ? `Missing required field(s): ${missingFields.join(", ")}. ` : "") +
						`Received (truncated): ${receivedSnippet}`,
				)
			}

			const result: ToolUse<TName> = {
				type: "tool_use" as const,
				name: resolvedName,
				params,
				partial: false, // Native tool calls are always complete when yielded
				nativeArgs,
			}

			// Preserve original name for API history when an alias was used
			if (toolCall.name !== resolvedName) {
				result.originalName = toolCall.name
			}

			// Track legacy format usage for telemetry
			if (usedLegacyFormat) {
				result.usedLegacyFormat = true
			}

			return result
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			this.lastParseError = errorMessage

			webviewLog.error(`Failed to parse tool call arguments: ${errorMessage}`)

			webviewLog.error(`Tool call: ${JSON.stringify(toolCall, null, 2)}`)
			return null
		}
	}

	/**
	 * Parse dynamic MCP tools (named mcp--serverName--toolName).
	 * These are generated dynamically by getMcpServerTools() and are returned
	 * as McpToolUse objects that preserve the original tool name.
	 */
	public static parseDynamicMcpTool(toolCall: { id: string; name: string; arguments: string }): McpToolUse | null {
		try {
			// Parse the arguments - these are the actual tool arguments passed directly
			const args = JSON.parse(toolCall.arguments || "{}")

			// Normalize the tool name to handle models that output underscores instead of hyphens
			// e.g., mcp__serverName__toolName -> mcp--serverName--toolName
			const normalizedName = normalizeMcpToolName(toolCall.name)

			// Extract server_name and tool_name from the tool name itself
			// Format: mcp--serverName--toolName (using -- separator)
			const parsed = parseMcpToolName(normalizedName)
			if (!parsed) {
				webviewLog.error(
					`Invalid dynamic MCP tool name format: ${toolCall.name} (normalized: ${normalizedName})`,
				)
				return null
			}

			const { serverName, toolName } = parsed

			const result: McpToolUse = {
				type: "mcp_tool_use" as const,
				id: toolCall.id,
				// Keep the original tool name (e.g., "mcp--serverName--toolName") for API history
				name: toolCall.name,
				serverName,
				toolName,
				arguments: args,
				partial: false,
			}

			return result
		} catch (error) {
			webviewLog.error(`Failed to parse dynamic MCP tool:`, error)
			return null
		}
	}
}
