import { z } from "zod"

/**
 * ShoferAsk
 */

/**
 * Array of possible ask types that the LLM can use to request user interaction or approval.
 * These represent different scenarios where the assistant needs user input to proceed.
 *
 * @constant
 * @readonly
 *
 * Ask type descriptions:
 * - `followup`: LLM asks a clarifying question to gather more information needed to complete the task
 * - `command`: Permission to execute a terminal/shell command
 * - `command_output`: Permission to read the output from a previously executed command
 * - `completion_result`: Task has been completed, awaiting user feedback or a new task
 * - `tool`: Permission to use a tool for file operations (read, write, search, etc.)
 * - `api_req_failed`: API request failed, asking user whether to retry
 * - `resume_task`: Confirmation needed to resume a previously paused task
 * - `resume_completed_task`: Confirmation needed to resume a task that was already marked as completed
 * - `mistake_limit_reached`: Too many errors encountered, needs user guidance on how to proceed
 * - `use_mcp_server`: Permission to use Model Context Protocol (MCP) server functionality
 * - `auto_approval_max_req_reached`: Auto-approval limit has been reached, manual approval required
 */
export const shoferAsks = [
	"followup",
	"command",
	"command_output",
	"completion_result",
	"tool",
	"api_req_failed",
	"resume_task",
	"resume_completed_task",
	"mistake_limit_reached",
	"use_mcp_server",
	"auto_approval_max_req_reached",
	"budget_limit",
] as const

export const shoferAskSchema = z.enum(shoferAsks)

export type ShoferAsk = z.infer<typeof shoferAskSchema>
/**
 * IdleAsk
 *
 * Asks that put the task into an "idle" state.
 */

export const idleAsks = [
	"completion_result",
	"api_req_failed",
	"resume_completed_task",
	"mistake_limit_reached",
	"auto_approval_max_req_reached",
] as const satisfies readonly ShoferAsk[]

export type IdleAsk = (typeof idleAsks)[number]

export function isIdleAsk(ask: ShoferAsk): ask is IdleAsk {
	return (idleAsks as readonly ShoferAsk[]).includes(ask)
}

/**
 * ResumableAsk
 *
 * Asks that put the task into an "resumable" state.
 */

export const resumableAsks = ["resume_task"] as const satisfies readonly ShoferAsk[]

export type ResumableAsk = (typeof resumableAsks)[number]

export function isResumableAsk(ask: ShoferAsk): ask is ResumableAsk {
	return (resumableAsks as readonly ShoferAsk[]).includes(ask)
}

/**
 * InteractiveAsk
 *
 * Asks that put the task into an "user interaction required" state.
 */

export const interactiveAsks = [
	"followup",
	"command",
	"tool",
	"use_mcp_server",
	"budget_limit",
] as const satisfies readonly ShoferAsk[]

export type InteractiveAsk = (typeof interactiveAsks)[number]

export function isInteractiveAsk(ask: ShoferAsk): ask is InteractiveAsk {
	return (interactiveAsks as readonly ShoferAsk[]).includes(ask)
}

/**
 * AutoApprovableAsk
 *
 * Asks that the auto-approval engine in the extension host can resolve
 * synchronously without any user input. The auto-approval fast-path in
 * `Task.ask()` short-circuits these asks and never enters `pWaitFor`,
 * so they are answered with a synthesized `yesButtonClicked` and the
 * agent loop keeps running uninterrupted.
 *
 * Membership constraint: an ask MUST only live here if it is genuinely
 * fire-and-forget (the LLM does not need a meaningful response). An ask
 * that ends a turn (e.g. `completion_result`) must NOT be in this list,
 * otherwise queued user messages and typed feedback are lost — see the
 * regression analysis in [`docs/task_states.md`](../../../docs/task_states.md).
 *
 * Today only `command_output` qualifies: it surfaces command output to
 * the chat while the command keeps streaming; the LLM doesn't actually
 * await a user decision.
 */

export const autoApprovableAsks = ["command_output"] as const satisfies readonly ShoferAsk[]

export type AutoApprovableAsk = (typeof autoApprovableAsks)[number]

export function isAutoApprovableAsk(ask: ShoferAsk): ask is AutoApprovableAsk {
	return (autoApprovableAsks as readonly ShoferAsk[]).includes(ask)
}

/**
 * AgentRunningAsk
 *
 * Asks that do NOT pause the agent loop. From the consumer's perspective
 * the agent is still actively executing — the ask is purely informational
 * (e.g. `command_output` while a long-running command streams output).
 *
 * This is a *consumer-side* predicate (used by the CLI agent state
 * detector and ask dispatcher) and is intentionally separate from
 * `isAutoApprovableAsk` even though they currently happen to share the
 * same membership. Conflating "the host auto-approves this" with "the
 * agent is still running" is what produced the original `nonBlockingAsks`
 * footgun: three different policies bolted onto one set.
 */

export const agentRunningAsks = ["command_output"] as const satisfies readonly ShoferAsk[]

export type AgentRunningAsk = (typeof agentRunningAsks)[number]

export function isAgentRunningAsk(ask: ShoferAsk): ask is AgentRunningAsk {
	return (agentRunningAsks as readonly ShoferAsk[]).includes(ask)
}

/**
 * ShoferSay
 */

/**
 * Array of possible say types that represent different kinds of messages the assistant can send.
 * These are used to categorize and handle various types of communication from the LLM to the user.
 *
 * @constant
 * @readonly
 *
 * Say type descriptions:
 * - `error`: General error message
 * - `api_req_started`: Indicates an API request has been initiated
 * - `api_req_finished`: Indicates an API request has completed successfully
 * - `api_req_retried`: Indicates an API request is being retried after a failure
 * - `api_req_retry_delayed`: Indicates an API request retry has been delayed
 * - `api_req_rate_limit_wait`: Indicates a configured rate-limit wait (not an error)
 * - `api_req_deleted`: Indicates an API request has been deleted/cancelled
 * - `text`: General text message or assistant response
 * - `reasoning`: Assistant's reasoning or thought process (often hidden from user)
 * - `completion_result`: Final result of task completion
 * - `user_feedback`: Message containing user feedback
 * - `user_feedback_diff`: Diff-formatted feedback from user showing requested changes
 * - `command_output`: Output from an executed command
 * - `shell_integration_warning`: Warning about shell integration issues or limitations
 * - `mcp_server_request_started`: MCP server request has been initiated
 * - `mcp_server_response`: Response received from MCP server
 * - `subtask_result`: Result of a completed subtask
 * - `checkpoint_saved`: Indicates a checkpoint has been saved
 * - `shoferignore_error`: Error related to .shoferignore file processing
 * - `diff_error`: Error occurred while applying a diff/patch
 * - `condense_context`: Context condensation/summarization has started
 * - `condense_context_error`: Error occurred during context condensation
 * - `rag_search_result`: Results from searching the codebase
 * - `too_many_tools_warning`: Warning that too many MCP tools are enabled, which may confuse the LLM
 */
export const shoferSays = [
	"error",
	"api_req_started",
	"api_req_finished",
	"api_req_retried",
	"api_req_retry_delayed",
	"api_req_rate_limit_wait",
	"api_req_deleted",
	"text",
	"image",
	"reasoning",
	"completion_result",
	"user_feedback",
	"user_feedback_diff",
	"command_output",
	"shell_integration_warning",
	"mcp_server_request_started",
	"mcp_server_response",
	"subtask_result",
	"checkpoint_saved",
	"shoferignore_error",
	"diff_error",
	"condense_context",
	"condense_context_error",
	"sliding_window_truncation",
	"rag_search_result",
	"git_search_result",
	"user_edit_todos",
	"too_many_tools_warning",
	"tool",
	"tool_preparing",
	"tool_result",
] as const

export const shoferSaySchema = z.enum(shoferSays)

export type ShoferSay = z.infer<typeof shoferSaySchema>

/**
 * ToolProgressStatus
 */

export const toolProgressStatusSchema = z.object({
	icon: z.string().optional(),
	text: z.string().optional(),
})

export type ToolProgressStatus = z.infer<typeof toolProgressStatusSchema>

/**
 * ContextCondense
 *
 * Data associated with a successful context condensation event.
 * This is attached to messages with `say: "condense_context"` when
 * the condensation operation completes successfully.
 *
 * @property cost - The API cost incurred for the condensation operation
 * @property prevContextTokens - Token count before condensation
 * @property newContextTokens - Token count after condensation
 * @property summary - The condensed summary that replaced the original context
 * @property condenseId - Optional unique identifier for this condensation operation
 */
export const contextCondenseSchema = z.object({
	cost: z.number(),
	prevContextTokens: z.number(),
	newContextTokens: z.number(),
	summary: z.string(),
	condenseId: z.string().optional(),
})

export type ContextCondense = z.infer<typeof contextCondenseSchema>

/**
 * ContextTruncation
 *
 * Data associated with a sliding window truncation event.
 * This is attached to messages with `say: "sliding_window_truncation"` when
 * messages are removed from the conversation history to stay within token limits.
 *
 * Unlike condensation, truncation simply removes older messages without
 * summarizing them. This is a faster but less context-preserving approach.
 *
 * @property truncationId - Unique identifier for this truncation operation
 * @property messagesRemoved - Number of conversation messages that were removed
 * @property prevContextTokens - Token count before truncation occurred
 * @property newContextTokens - Token count after truncation occurred
 */
export const contextTruncationSchema = z.object({
	truncationId: z.string(),
	messagesRemoved: z.number(),
	prevContextTokens: z.number(),
	newContextTokens: z.number(),
})

export type ContextTruncation = z.infer<typeof contextTruncationSchema>

/**
 * ShoferMessage
 *
 * The main message type used for communication between the extension and webview.
 * Messages can either be "ask" (requiring user response) or "say" (informational).
 *
 * Context Management Fields:
 * - `contextCondense`: Present when `say: "condense_context"` and condensation succeeded
 * - `contextTruncation`: Present when `say: "sliding_window_truncation"` and truncation occurred
 *
 * Note: These fields are mutually exclusive - a message will have at most one of them.
 */
export const shoferMessageSchema = z.object({
	ts: z.number(),
	type: z.union([z.literal("ask"), z.literal("say")]),
	ask: shoferAskSchema.optional(),
	say: shoferSaySchema.optional(),
	text: z.string().optional(),
	images: z.array(z.string()).optional(),
	partial: z.boolean().optional(),
	reasoning: z.string().optional(),
	conversationHistoryIndex: z.number().optional(),
	checkpoint: z.record(z.string(), z.unknown()).optional(),
	progressStatus: toolProgressStatusSchema.optional(),
	/**
	 * Data for successful context condensation.
	 * Present when `say: "condense_context"` and `partial: false`.
	 */
	contextCondense: contextCondenseSchema.optional(),
	/**
	 * Data for sliding window truncation.
	 * Present when `say: "sliding_window_truncation"`.
	 */
	contextTruncation: contextTruncationSchema.optional(),
	isProtected: z.boolean().optional(),
	apiProtocol: z.union([z.literal("openai"), z.literal("anthropic")]).optional(),
	isAnswered: z.boolean().optional(),
	/**
	 * Stable identity of the streamed assistant content block that produced this
	 * message. Set for streamed `say: "text"` (and reasoning) messages so that
	 * the streaming → finalization handoff in `Task.say()` can locate the owning
	 * message by identity rather than by tail position. This makes finalization
	 * immune to other messages (tool_result, errors, grounding sources, …) being
	 * appended to `shoferMessages` between the partial emission and its
	 * finalization, which previously produced duplicate "Shofer said" bubbles.
	 */
	streamBlockId: z.string().optional(),
	/**
	 * True when this `ask` was auto-approved by `checkAutoApproval` and the
	 * task short-circuited the wait-for-user-response flow. The webview uses
	 * this flag to suppress the Approve/Deny action buttons that would
	 * otherwise be presented for the ask, since no input is required.
	 */
	autoApproved: z.boolean().optional(),
})

export type ShoferMessage = z.infer<typeof shoferMessageSchema>

/**
 * TokenUsage
 */

export const tokenUsageSchema = z.object({
	totalTokensIn: z.number(),
	totalTokensOut: z.number(),
	totalCacheWrites: z.number().optional(),
	totalCacheReads: z.number().optional(),
	totalCost: z.number(),
	contextTokens: z.number(),
})

export type TokenUsage = z.infer<typeof tokenUsageSchema>

/**
 * QueuedMessage
 */

export const queuedMessageSchema = z.object({
	timestamp: z.number(),
	id: z.string(),
	text: z.string(),
	images: z.array(z.string()).optional(),
})

export type QueuedMessage = z.infer<typeof queuedMessageSchema>
