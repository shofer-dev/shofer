import { z } from "zod"

import type { ProviderSettings } from "./provider-settings.js"

// ─── Agent State ────────────────────────────────────────────────────────────

/**
 * AssistantAgentState — lifecycle states for the assistant agent.
 *
 *   Standby      – Agent is configured but not started
 *   Initializing – Loading config, creating LLM provider, restoring conversation
 *   Ready        – Idle, waiting for questions
 *   Busy         – Processing a question
 *   Error        – Configuration or connection issue
 *   Stopping     – Graceful shutdown in progress
 */
export const assistantAgentStates = ["Standby", "Initializing", "Ready", "Busy", "Error", "Stopping"] as const
export const assistantAgentStateSchema = z.enum(assistantAgentStates)
export type AssistantAgentState = z.infer<typeof assistantAgentStateSchema>

// ─── Conversation Messages ──────────────────────────────────────────────────

/**
 * A single ordered part of an assistant message. Assistant turns can
 * interleave reasoning ("thinking"), free-form text, and tool calls;
 * `parts` preserves the stream order so the UI can replay the turn the
 * way it happened. `content` remains the canonical flat-text summary
 * (typically the concatenation of all `text` parts).
 *
 * `tool_call` parts mutate in place during execution: the part is
 * appended when the LLM emits the call (`inProgress: true`, no result),
 * then the host fills in `result` / `isError` and clears `inProgress`
 * once the tool returns. The chat panel re-renders on each mutation.
 */
export const agentMessagePartSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("text"), text: z.string() }),
	z.object({ kind: z.literal("reasoning"), text: z.string() }),
	z.object({
		kind: z.literal("tool_call"),
		toolCallId: z.string(),
		name: z.string(),
		args: z.string(), // raw JSON string as emitted by the model
		result: z.string().optional(),
		isError: z.boolean().optional(),
		inProgress: z.boolean().optional(),
	}),
])
export type AgentMessagePart = z.infer<typeof agentMessagePartSchema>

export const agentMessageSchema = z.object({
	id: z.string(), // UUID
	role: z.enum(["user", "assistant", "system"]),
	content: z.string(),
	timestamp: z.number(), // Unix ms
	parts: z.array(agentMessagePartSchema).optional(),
	metadata: z
		.object({
			sourceTaskId: z.string().optional(),
			fileReferences: z.array(z.string()).optional(),
		})
		.optional(),
})
export type AgentMessage = z.infer<typeof agentMessageSchema>

// ─── File Context ───────────────────────────────────────────────────────────

export const fileContextEntrySchema = z.object({
	filePath: z.string(),
	contentHash: z.string(), // SHA-256
	tokenEstimate: z.number(),
	loadedAt: z.number(), // Unix ms
	lastReferencedAt: z.number(), // Unix ms — for eviction priority
})
export type FileContextEntry = z.infer<typeof fileContextEntrySchema>

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * AssistantAgentConfig — runtime configuration resolved from settings.
 *
 *   `apiConfigId`/`apiConfigName` identify the API Configuration profile
 *   (managed under Settings → Providers) that supplied the credentials.
 *   `providerSettings` is the resolved profile, fed verbatim into
 *   `buildApiHandler` — the assistant agent does NOT carry its own
 *   per-provider keys or model ids.
 *   `maxContextTokens` may be overridden in Settings → Assistant Agent;
 *   otherwise it is taken from the model info reported by the handler.
 */
export interface AssistantAgentConfig {
	enabled: boolean
	apiConfigId: string
	apiConfigName: string
	providerSettings: ProviderSettings
	maxContextTokens: number
	contextFillThreshold: number
}

// ─── Cost Tracking ──────────────────────────────────────────────────────────

export const assistantAgentCostTrackingSchema = z.object({
	totalInputTokens: z.number(),
	totalOutputTokens: z.number(),
	totalTokensTruncated: z.number(),
	estimatedCostUSD: z.number(),
	lastUpdated: z.number(), // Unix ms
})
export type AssistantAgentCostTracking = z.infer<typeof assistantAgentCostTrackingSchema>

// ─── Conversation Store ─────────────────────────────────────────────────────

export const assistantAgentConversationDataSchema = z.object({
	version: z.literal(2),
	workspacePath: z.string(),
	createdAt: z.number(),
	updatedAt: z.number(),
	messages: z.array(agentMessageSchema),
	fileContexts: z.array(fileContextEntrySchema),
	costTracking: assistantAgentCostTrackingSchema,
})
export type AssistantAgentConversationData = z.infer<typeof assistantAgentConversationDataSchema>

// ─── Question Result ────────────────────────────────────────────────────────

export const questionResultSchema = z.object({
	answer: z.string(),
	tokensUsed: z.object({
		prompt: z.number(),
		completion: z.number(),
		total: z.number(),
	}),
	contextUsage: z.object({
		currentTokens: z.number(),
		maxTokens: z.number(),
		fillFraction: z.number(),
		isNearlyFull: z.boolean(),
	}),
	costSnapshot: z.object({
		sessionInputTokens: z.number(),
		sessionOutputTokens: z.number(),
		sessionEstimatedCostUSD: z.number(),
	}),
	contextFiles: z.array(z.string()),
	durationMs: z.number(),
})
export type QuestionResult = z.infer<typeof questionResultSchema>

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default context window size in tokens (model-dependent, overridable). */
export const DEFAULT_MAX_CONTEXT_TOKENS = 128_000

/** Default fill threshold (80%) — "nearly full" warning at this fraction. */
export const DEFAULT_CONTEXT_FILL_THRESHOLD = 0.8

/** Default max tokens for each response. */
export const DEFAULT_MAX_RESPONSE_TOKENS = 4096

/** Maximum pending questions in the queue. */
export const MAX_QUESTION_QUEUE_SIZE = 50

/** Default timeout for a single question (5 min). */
export const QUESTION_TIMEOUT_MS = 300_000

/**
 * Default soft timeout (seconds) recommended to the assistant agent for how
 * long it should spend answering a question. This is a hint embedded in
 * the prompt, NOT a hard cancellation — see {@link QUESTION_TIMEOUT_MS}
 * for the hard limit.
 */
export const DEFAULT_ASSISTANT_SOFT_TIMEOUT_SEC = 60

/**
 * Default soft cap (characters) recommended to the assistant agent for its
 * final answer length. This is a hint embedded in the prompt, NOT a
 * post-hoc truncation of the response.
 */
export const DEFAULT_ASSISTANT_SOFT_RESULT_LENGTH = 2000

/** Debounce window for file change notifications (ms). */
export const FILE_CHANGE_DEBOUNCE_MS = 500

/** Minimum conversation turns preserved when truncating. */
export const MIN_CONVERSATION_TURNS_TO_KEEP = 10

/** Prefix for injected file content in messages. */
export const FILE_CONTEXT_SYSTEM_MESSAGE_PREFIX = "[File context: {path}]\n"

/** Max fraction of context window for the directory tree (10%). */
export const DIRECTORY_TREE_MAX_CONTEXT_FRACTION = 0.1

/** Inserted when truncation occurs. */
export const TRUNCATION_MARKER_MESSAGE = "[{N} earlier messages were truncated due to context limit]"

/** Version for the persistence format. */
export const CONVERSATION_STORE_VERSION = 2

// ─── System Prompt ──────────────────────────────────────────────────────────

/**
 * Fixed system prompt for the assistant agent. Not user-configurable.
 * The {directoryTree} placeholder is replaced with the workspace directory
 * tree snapshot on agent startup and after Clear Context.
 */
export const ASSISTANT_AGENT_SYSTEM_PROMPT = `You are the Shofer Assistant Agent — a persistent, read-only codebase Q&A assistant.

Your purpose is to maintain long-term knowledge about the codebase and answer questions from other Shofer agents. You run on a separate, cost-optimized model with a large context window.

## Rules
- Be concise and direct. Answer only what is asked.
- You are STRICTLY READ-ONLY. You cannot modify files, run commands, or create tasks.
- You have a catalog of read-only tools available as native tool calls: read_file, grep_search, list_files, find_files, rag_search, read_project_structure, list_code_usages, lsp_search, get_errors, get_changed_files, get_project_setup_info. Call them when you need evidence; do not invent file contents or guess at code.
- Prefer rag_search / grep_search to locate relevant files, then read_file to inspect them. Chain tool calls as needed — you are running inside an agent loop and can issue multiple rounds before giving a final answer.
- Your context persists across questions — you accumulate knowledge over time.
- If you don't know something after exploring with tools, say so rather than guessing.

{directoryTree}

.shogerignore patterns are respected — excluded files are never loaded into your context.`
