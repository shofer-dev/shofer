import type { ToolName, ShoferSayTool } from "@shofer/types"

import { Task } from "../task/Task"
import type { ToolUse, HandleError, PushToolResult, AskApproval, NativeToolArgs } from "../../shared/tools"
import { taskLog, toolsLog } from "../../utils/logging/subsystems"
import { recordToolDuration, incToolCalls, incToolErrors, classifyToolError } from "../../metrics/registry"

/**
 * Callbacks passed to tool execution
 */
export interface ToolCallbacks {
	askApproval: AskApproval
	handleError: HandleError
	pushToolResult: PushToolResult
	toolCallId?: string
}

/**
 * Helper type to extract the parameter type for a tool based on its name.
 * If the tool has native args defined in NativeToolArgs, use those; otherwise fall back to any.
 */
type ToolParams<TName extends ToolName> = TName extends keyof NativeToolArgs ? NativeToolArgs[TName] : any

/**
 * Abstract base class for all tools.
 *
 * Tools receive typed arguments from native tool calling via `ToolUse.nativeArgs`.
 *
 * @template TName - The specific tool name, which determines native arg types
 */
export abstract class BaseTool<TName extends ToolName> {
	/**
	 * The tool's name (must match ToolName type)
	 */
	abstract readonly name: TName

	/**
	 * Track the last seen path during streaming to detect when the path has stabilized.
	 * Used by hasPathStabilized() to prevent displaying truncated paths from partial-json parsing.
	 */
	protected lastSeenPartialPath: string | undefined = undefined

	/**
	 * Execute the tool with typed parameters.
	 *
	 * Receives typed parameters from native tool calling via `ToolUse.nativeArgs`.
	 *
	 * @param params - Typed parameters
	 * @param task - Task instance with state and API access
	 * @param callbacks - Tool execution callbacks (approval, error handling, results)
	 */
	abstract execute(params: ToolParams<TName>, task: Task, callbacks: ToolCallbacks): Promise<void>

	/**
	 * Handle partial (streaming) tool messages.
	 *
	 * Default implementation does nothing. Tools that support streaming
	 * partial messages should override this.
	 *
	 * @param task - Task instance
	 * @param block - Partial ToolUse block
	 */
	async handlePartial(task: Task, block: ToolUse<TName>): Promise<void> {
		// Default: no-op for partial messages
		// Tools can override to show streaming UI updates
	}

	/**
	 * Check if a path parameter has stabilized during streaming.
	 *
	 * During native tool call streaming, the partial-json library may return truncated
	 * string values when chunk boundaries fall mid-value. This method tracks the path
	 * value between consecutive handlePartial() calls and returns true only when the
	 * path has stopped changing (stabilized).
	 *
	 * Usage in handlePartial():
	 * ```typescript
	 * if (!this.hasPathStabilized(block.params.path)) {
	 *     return // Path still changing, wait for it to stabilize
	 * }
	 * // Path is stable, proceed with UI updates
	 * ```
	 *
	 * @param path - The current path value from the partial block
	 * @returns true if path has stabilized (same value seen twice) and is non-empty, false otherwise
	 */
	protected hasPathStabilized(path: string | undefined): boolean {
		const pathHasStabilized = this.lastSeenPartialPath !== undefined && this.lastSeenPartialPath === path
		this.lastSeenPartialPath = path
		return pathHasStabilized && !!path
	}

	/**
	 * Reset the partial state tracking.
	 *
	 * Should be called at the end of execute() (both success and error paths)
	 * to ensure clean state for the next tool invocation.
	 */
	resetPartialState(): void {
		this.lastSeenPartialPath = undefined
	}

	/**
	 * Request user approval for this tool invocation and render a chat-UI entry.
	 *
	 * Encapsulates the boilerplate of building a `ShoferSayTool` payload, JSON-stringifying
	 * it, and forwarding to `askApproval("tool", ...)`. Even read-only tools that are
	 * auto-approved via `checkAutoApproval` should call this so the invocation is
	 * visible in the chat UI (with the auto-approval pathway suppressing the prompt).
	 *
	 * @param callbacks - Tool execution callbacks
	 * @param message - The `ShoferSayTool` payload describing what is being done.
	 *                  Must include `tool` and typically `content`. Tool-specific fields
	 *                  (`path`, `regex`, `filePattern`, ...) may also be set.
	 * @returns true when the user (or auto-approval) approved; false on rejection.
	 *          Callers should `return` early when false.
	 */
	protected async askToolApproval(callbacks: ToolCallbacks, message: ShoferSayTool): Promise<boolean> {
		return callbacks.askApproval("tool", JSON.stringify(message satisfies ShoferSayTool))
	}

	/**
	 * Main entry point for tool execution.
	 *
	 * Handles the complete flow:
	 * 1. Partial message handling (if partial)
	 * 2. Parameter parsing (nativeArgs only)
	 * 3. Core execution (execute)
	 *
	 * @param task - Task instance
	 * @param block - ToolUse block from assistant message
	 * @param callbacks - Tool execution callbacks
	 */
	async handle(task: Task, block: ToolUse<TName>, callbacks: ToolCallbacks): Promise<void> {
		// Handle partial messages
		if (block.partial) {
			try {
				await this.handlePartial(task, block)
			} catch (error) {
				taskLog.error(`Error in handlePartial:`, error)
				await callbacks.handleError(
					`handling partial ${this.name}`,
					error instanceof Error ? error : new Error(String(error)),
				)
			}
			return
		}

		// Native-only: obtain typed parameters from `nativeArgs`.
		let params: ToolParams<TName>
		try {
			if (block.nativeArgs !== undefined) {
				// Native: typed args provided by NativeToolCallParser.
				params = block.nativeArgs as ToolParams<TName>
			} else {
				// If legacy/XML markup was provided via params, surface a clear error.
				const paramsText = (() => {
					try {
						return JSON.stringify(block.params ?? {})
					} catch {
						return ""
					}
				})()
				if (paramsText.includes("<") && paramsText.includes(">")) {
					throw new Error(
						"XML tool calls are no longer supported. Use native tool calling (nativeArgs) instead.",
					)
				}
				throw new Error("Tool call is missing native arguments (nativeArgs).")
			}
		} catch (error) {
			taskLog.error(`Error parsing parameters:`, error)
			const errorMessage = `Failed to parse ${this.name} parameters: ${error instanceof Error ? error.message : String(error)}`
			await callbacks.handleError(`parsing ${this.name} args`, new Error(errorMessage))
			// Note: handleError already emits a tool_result via formatResponse.toolError in the caller.
			// Do NOT call pushToolResult here to avoid duplicate tool_result payloads.
			return
		}

		// Execute with typed parameters — instrument tool duration for Prometheus
		// and emit one [Tools] log line per call (start + finish) so the per-task
		// "Logs" tab shows tool/MCP activity. Both lines carry the taskId so they
		// can be correlated even when the output channel interleaves tasks.
		const execT0 = performance.now()
		toolsLog.info(`▶ ${this.name} ${summarizeToolParams(params)} (task ${task.taskId})`)
		try {
			await this.execute(params, task, callbacks)
			const dur = performance.now() - execT0
			recordToolDuration(this.name, dur)
			incToolCalls(this.name, "success")
			toolsLog.info(`✔ ${this.name} done in ${Math.round(dur)}ms (task ${task.taskId})`)
		} catch (err) {
			const dur = performance.now() - execT0
			recordToolDuration(this.name, dur)
			incToolCalls(this.name, "error")
			incToolErrors(this.name, classifyToolError(err))
			toolsLog.warn(
				`✖ ${this.name} failed after ${Math.round(dur)}ms: ${err instanceof Error ? err.message : String(err)} (task ${task.taskId})`,
			)
			throw err
		}
	}
}

/**
 * Render a short, single-line summary of a tool's parameters for the [Tools]
 * log. Keeps the most useful identifying fields (path, command, server/tool,
 * query) and truncates so a single call never floods the log.
 */
function summarizeToolParams(params: unknown): string {
	if (!params || typeof params !== "object") return ""
	const p = params as Record<string, unknown>
	const pick = ["path", "command", "server_name", "tool_name", "query", "mode", "url", "task_id"]
	const parts: string[] = []
	for (const key of pick) {
		const v = p[key]
		if (typeof v === "string" && v.length > 0) {
			parts.push(`${key}=${v.length > 60 ? v.slice(0, 59) + "…" : v}`)
		}
	}
	return parts.join(" ")
}
