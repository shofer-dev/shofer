/**
 * Live Memory plugin — domain types, constants, and system prompt.
 *
 * These definitions are OWNED by the plugin: they describe the plugin's own
 * conversation/context/cost model and are used only by the Live Memory plugin
 * modules. They were previously carried in `@shofer/types` (back when Live
 * Memory was a built-in subsystem); with the built-in removed, they live here
 * so the plugin is fully self-contained and leaves zero footprint in
 * `@shofer/core` / `@shofer/types`.
 *
 * `z` is the zod instance re-exported by the SDK surface (`parametersSchema`),
 * matching how the rest of the plugin accesses zod — the plugin imports only
 * from `@shofer/types` (plus node builtins), never raw npm packages, so it
 * bundles cleanly through the runtime esbuild loader.
 */

import { parametersSchema as z } from "@shofer/types"

// ─── Agent State ────────────────────────────────────────────────────────────

/**
 * LiveMemoryState — lifecycle states for the live memory agent.
 *
 *   Standby      – Agent is configured but not started
 *   Initializing – Loading config, creating LLM provider, restoring conversation
 *   Ready        – Idle, waiting for questions
 *   Busy         – Processing a question
 *   Error        – Configuration or connection issue
 *   Stopping     – Graceful shutdown in progress
 */
export const liveMemoryStates = ["Standby", "Initializing", "Ready", "Busy", "Error", "Stopping"] as const
export const liveMemoryStateSchema = z.enum(liveMemoryStates)
export type LiveMemoryState = z.infer<typeof liveMemoryStateSchema>

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
			/**
			 * Marks a **memory-update delta** appended to the history so a change
			 * (new observations since the volatile block was frozen) reaches the
			 * model WITHOUT mutating the frozen prefix — mutation would truncate
			 * the provider's KV cache at the first changed byte. Delta messages
			 * are rendered by the panel like any other turn.
			 */
			observation: z.boolean().optional(),
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

// ─── Pre-loaded Reference Documents ─────────────────────────────────────────

/**
 * A document loaded VERBATIM into the memory agent's system prompt from the
 * `preloadGlobs` config — reference material the memory starts out knowing
 * (e.g. `docs/*.md`). Preloaded docs live outside the evictable ContextWindow:
 * they are a fixed prompt overhead, re-read fresh from disk on agent creation
 * and on the `reset` command, and their token estimate is subtracted from the
 * window budget so eviction math stays honest.
 */
export interface PreloadedDoc {
	filePath: string
	content: string
	contentHash: string // SHA-256 at load time
	tokenEstimate: number
}

// ─── Cost Tracking ──────────────────────────────────────────────────────────

export const liveMemoryCostTrackingSchema = z.object({
	totalInputTokens: z.number(),
	totalOutputTokens: z.number(),
	totalTokensTruncated: z.number(),
	estimatedCostUSD: z.number(),
	lastUpdated: z.number(), // Unix ms
})
export type LiveMemoryCostTracking = z.infer<typeof liveMemoryCostTrackingSchema>

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
 * Default soft timeout (seconds) recommended to the live memory for how
 * long it should spend answering a question. This is a hint embedded in
 * the prompt, NOT a hard cancellation — see {@link QUESTION_TIMEOUT_MS}
 * for the hard limit.
 */
export const DEFAULT_LIVE_MEMORY_SOFT_TIMEOUT_SEC = 60

/**
 * Default soft cap (characters) recommended to the live memory for its
 * final answer length. This is a hint embedded in the prompt, NOT a
 * post-hoc truncation of the response.
 */
export const DEFAULT_LIVE_MEMORY_SOFT_RESULT_LENGTH = 2000

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

// ─── Preload (verbatim reference docs) ──────────────────────────────────────

/** Default total byte cap across all preloaded docs (`preloadMaxTotalBytes` config). */
export const DEFAULT_PRELOAD_MAX_TOTAL_BYTES = 2_097_152

/** Per-file byte cap on a single preloaded doc (files larger than this are truncated). */
export const PRELOAD_MAX_FILE_BYTES = 262_144

/**
 * Preload is additionally clamped to this fraction of the context-window budget:
 * preloading past it would leave no room for conversation and force immediate
 * eviction of the very docs the user configured to be verbatim.
 */
export const PRELOAD_BUDGET_FRACTION = 0.6

// ─── KV/prompt-cache keep-warm heartbeat ────────────────────────────────────

/** Default heartbeat period (4 minutes — just under typical provider cache TTLs). */
export const DEFAULT_KEEP_WARM_INTERVAL_MS = 240_000

/** Stop warming a workspace whose last real question is older than this (30 min). */
export const KEEP_WARM_MAX_IDLE_MS = 1_800_000

// ─── System Prompt ──────────────────────────────────────────────────────────

/**
 * Fixed system prompt for the live memory. Not user-configurable.
 * The {directoryTree} placeholder is replaced with the workspace directory
 * tree snapshot on agent startup and after Clear Context.
 */
export const LIVE_MEMORY_SYSTEM_PROMPT = `You are the Shofer Live Memory — a persistent, read-only codebase Q&A assistant.

Your purpose is to maintain long-term knowledge about the codebase and answer questions from other Shofer agents. You run on a separate, cost-optimized model with a large context window.

## Rules
- Be concise and direct. Answer only what is asked.
- You are STRICTLY READ-ONLY. You cannot modify files, run commands, or create tasks.
- You have a catalog of read-only tools available as native tool calls: read_file, grep_search, list_files, find_files, rag_search, read_project_structure, list_code_usages, lsp_search, get_errors, get_changed_files, get_project_setup_info. Call them when you need evidence you don't already have; do not invent file contents or guess at code.
- Your context window persists across questions — you accumulate knowledge over time. Treat it as your primary source of truth.

## Context-First Knowledge (CRITICAL)
- ALWAYS review your existing conversation history BEFORE making any tool calls. If the answer (or a substantially similar one) is already in your context window, answer from that knowledge directly.
- Repeated or near-identical questions are expected and normal — agents often ask the same thing multiple times. When you recognize a question you've already explored, answer immediately from memory. Do NOT re-search or re-verify — BUT if your system prompt lists any files as "recently modified," your cached knowledge of those files may be stale, so re-read them BEFORE answering if the question concerns them.
- Use tool calls ONLY when your context window genuinely lacks the information needed to answer (or when a relevant file is flagged as recently modified). Each tool round-trip costs time and tokens — avoid them when you already have current knowledge.
- If you do need to explore, prefer rag_search / grep_search to locate relevant files, then read_file to inspect them. You can chain multiple tool calls in one iteration.

## When You Don't Know
- If you don't know something after exploring with tools, say so rather than guessing.
- If a question requires knowledge you cannot acquire with your read-only tool set, say so clearly.

{directoryTree}

.shogerignore patterns are respected — excluded files are never loaded into your context.`
