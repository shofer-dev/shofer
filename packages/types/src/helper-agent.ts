import { z } from "zod"

import type { ProviderSettings } from "./provider-settings.js"

// ─── Agent State ────────────────────────────────────────────────────────────

/**
 * HelperAgentState — lifecycle states for the helper agent.
 *
 *   Standby      – Agent is configured but not started
 *   Initializing – Loading config, creating LLM provider, restoring conversation
 *   Ready        – Idle, waiting for questions
 *   Busy         – Processing a question
 *   Error        – Configuration or connection issue
 *   Stopping     – Graceful shutdown in progress
 */
export const helperAgentStates = ["Standby", "Initializing", "Ready", "Busy", "Error", "Stopping"] as const
export const helperAgentStateSchema = z.enum(helperAgentStates)
export type HelperAgentState = z.infer<typeof helperAgentStateSchema>

// ─── Conversation Messages ──────────────────────────────────────────────────

export const agentMessageSchema = z.object({
	id: z.string(), // UUID
	role: z.enum(["user", "assistant", "system"]),
	content: z.string(),
	timestamp: z.number(), // Unix ms
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
 * HelperAgentConfig — runtime configuration resolved from settings.
 *
 *   `apiConfigId`/`apiConfigName` identify the API Configuration profile
 *   (managed under Settings → Providers) that supplied the credentials.
 *   `providerSettings` is the resolved profile, fed verbatim into
 *   `buildApiHandler` — the helper agent does NOT carry its own
 *   per-provider keys or model ids.
 *   `maxContextTokens` may be overridden in Settings → Helper Agent;
 *   otherwise it is taken from the model info reported by the handler.
 */
export interface HelperAgentConfig {
	enabled: boolean
	apiConfigId: string
	apiConfigName: string
	providerSettings: ProviderSettings
	maxContextTokens: number
	contextFillThreshold: number
}

// ─── Cost Tracking ──────────────────────────────────────────────────────────

export const helperAgentCostTrackingSchema = z.object({
	totalInputTokens: z.number(),
	totalOutputTokens: z.number(),
	totalTokensTruncated: z.number(),
	estimatedCostUSD: z.number(),
	lastUpdated: z.number(), // Unix ms
})
export type HelperAgentCostTracking = z.infer<typeof helperAgentCostTrackingSchema>

// ─── Conversation Store ─────────────────────────────────────────────────────

export const helperAgentConversationDataSchema = z.object({
	version: z.literal(1),
	workspacePath: z.string(),
	createdAt: z.number(),
	updatedAt: z.number(),
	messages: z.array(agentMessageSchema),
	fileContexts: z.array(fileContextEntrySchema),
	costTracking: helperAgentCostTrackingSchema,
})
export type HelperAgentConversationData = z.infer<typeof helperAgentConversationDataSchema>

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
 * Default soft timeout (seconds) recommended to the helper agent for how
 * long it should spend answering a question. This is a hint embedded in
 * the prompt, NOT a hard cancellation — see {@link QUESTION_TIMEOUT_MS}
 * for the hard limit.
 */
export const DEFAULT_HELPER_SOFT_TIMEOUT_MS = 60_000

/**
 * Default soft cap (characters) recommended to the helper agent for its
 * final answer length. This is a hint embedded in the prompt, NOT a
 * post-hoc truncation of the response.
 */
export const DEFAULT_HELPER_SOFT_RESULT_LENGTH = 2000

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
export const CONVERSATION_STORE_VERSION = 1

// ─── System Prompt ──────────────────────────────────────────────────────────

/**
 * Fixed system prompt for the helper agent. Not user-configurable.
 * The {directoryTree} placeholder is replaced with the workspace directory
 * tree snapshot on agent startup and after Clear Context.
 */
export const HELPER_AGENT_SYSTEM_PROMPT = `You are the Shofer Helper Agent — a persistent, read-only codebase Q&A assistant.

Your purpose is to maintain long-term knowledge about the codebase and answer questions from other Shofer agents. You run on a separate, cost-optimized model with a large context window.

## Rules
- Be concise and direct. Answer only what is asked.
- You are STRICTLY READ-ONLY. You cannot modify files, run commands, or create tasks.
- You have a catalog of read-only tools available as native tool calls: read_file, grep_search, list_files, find_files, rag_search, read_project_structure, list_code_usages, lsp_search, get_errors, get_changed_files, get_project_setup_info, fetch_web_page, view_image. Call them when you need evidence; do not invent file contents or guess at code.
- Prefer rag_search / grep_search to locate relevant files, then read_file to inspect them. Chain tool calls as needed — you are running inside an agent loop and can issue multiple rounds before giving a final answer.
- Your context persists across questions — you accumulate knowledge over time.
- If you don't know something after exploring with tools, say so rather than guessing.

{directoryTree}

.shogerignore patterns are respected — excluded files are never loaded into your context.`
