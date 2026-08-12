/**
 * @fileoverview Central registry of `@shofer/core`'s tunable magic numbers and
 * defaults.
 *
 * Every *internal knob* and every *default* for a user-configurable setting that
 * is safe to change without correctness impact lives here, so the system's
 * behaviour is reviewable and editable in one place — no magic numbers scattered
 * across modules. User configuration itself still flows through the host's
 * settings (e.g. `shoferBlobCapBytes`), tool args, and provider profiles; this
 * module holds only the values those fall back to, plus internal caps that are
 * not user-configurable but are freely tunable.
 *
 *
 * ── Deliberately NOT here (not "tunable magic numbers") ──────────────────────
 * These are protocol constraints, wire-format sizes, algorithmic invariants, or
 * reference data — changing them changes correctness/compatibility, not just a
 * tuning trade-off. They stay at their definition site on purpose:
 *
 *   - `SAFE_INT_MAX` (tools/defineNativeTool.ts) — JS `Number.MAX_SAFE_INTEGER`
 *     invariant used for schema bounds; not a knob.
 *   - `ACP_PROTOCOL_VERSION` (transport/acp-agent-server.ts) — wire protocol
 *     version; bumping it is a protocol change, not tuning.
 *   - `OPENAI_CALL_ID_MAX_LENGTH` (utils/tool-id.ts) — OpenAI wire-format
 *     constraint on tool-call ids; fixed by the provider's API.
 *   - `EPSILON` (auto-approval/AutoApprovalHandler.ts) — floating-point compare
 *     epsilon; an algorithmic constant, not a preference.
 *   - `MAX_CONTROL_FLOW_STEPS` (workflow/slang-interpreter.ts) — interpreter
 *     infinite-loop guard; an algorithmic safety invariant.
 *   - `BLOB_REF_REGEX` and the `<shofer-blob .../>` token shape
 *     (blob-store/BlobStore.ts) — a persisted wire format, not a number.
 *   - `MIN_CONDENSE_THRESHOLD` / `MAX_CONDENSE_THRESHOLD` (condense/index.ts) —
 *     validation *bounds* for a user setting, not defaults; live with their
 *     validator.
 *   - Provider-specific defaults (e.g. `DEFAULT_THINKING_BUDGET` in poe.ts,
 *     `XAI_DEFAULT_TEMPERATURE`, `TOKEN_REFRESH_BUFFER_MS`) — per-model tuning is
 *     integrator-owned and lives with each provider adapter.
 *   - Subsystem constant modules that are already consolidated per-subsystem:
 *     `services/code-index/constants/index.ts`, `services/glob/constants.ts`,
 *     and `task/subtask-limits.ts`. Those are left in place; this file does not
 *     re-home them.
 *   - Token/heuristic factors tightly coupled to an estimator
 *     (`TOKEN_FUDGE_FACTOR` in utils/tiktoken.ts, `CHARS_PER_TOKEN` in the
 *     live-memory mirror) — left with the estimator they calibrate.
 */

// ── logging: in-memory buffers ───────────────────────────────────────────────

/** Max recent human-readable log lines kept in the global ring buffer. */
export const RING_BUFFER_CAPACITY = 5000

/** Max log lines retained per task in the per-task ring buffers. */
export const TASK_RING_CAPACITY = 2000

/**
 * Max number of distinct tasks whose log buffers are retained at once. Bounds
 * memory when many tasks run over a session; the oldest task buffer is evicted
 * when a new task exceeds this cap.
 */
export const MAX_TASK_BUFFERS = 64

/**
 * Max bytes a single serialized (non-string) log argument may occupy before it
 * is truncated with a "…[+N more bytes]" suffix. Unit: bytes. Shared by the
 * CompactLogger arg formatter and the output-channel `stringifyForLog` cap.
 */
export const LOG_MAX_ARG_BYTES = 8 * 1024

// ── terminal: UI display truncation ──────────────────────────────────────────
// These bound the terminal output rendered in the chat UI to prevent unbounded
// memory growth. They are UI display limits, NOT LLM context limits (the latter
// are controlled by the `terminalOutputPreviewSize` setting).

/** Max lines of compressed terminal output kept for UI display. */
export const TERMINAL_OUTPUT_LINE_LIMIT = 500

/** Max characters of compressed terminal output kept for UI display. */
export const TERMINAL_OUTPUT_CHARACTER_LIMIT = 50_000

// ── blob store ───────────────────────────────────────────────────────────────

/**
 * Default inline-content cap (bytes): strings larger than this are externalised
 * to a per-task blob file and replaced with a reference token. Override
 * precedence: the `shoferBlobCapBytes` host setting wins when set; a value of
 * `0` disables externalisation. This is the fallback used when unset.
 */
export const DEFAULT_BLOB_CAP_BYTES = 2048

// ── custom tools: esbuild runner ─────────────────────────────────────────────

/**
 * Max directory levels to walk upward when locating `esbuild-wasm/bin/esbuild`
 * from a start directory. A safety bound on the ascent; monorepo layouts are far
 * shallower than this.
 */
export const ESBUILD_PROJECT_ROOT_MAX_DEPTH = 10

// ── task: retry / timeout / throttle knobs ───────────────────────────────────

/** Ceiling (seconds) for exponential backoff between LLM retry attempts. */
export const MAX_EXPONENTIAL_BACKOFF_SECONDS = 600

/** Soft deadline (ms) for collecting final usage metadata after a stream ends. */
export const DEFAULT_USAGE_COLLECTION_TIMEOUT_MS = 5000

/**
 * On a context-window-exceeded error, the percent of the current context to keep
 * (i.e. remove `100 - this`%) when forcing a truncation/condense pass. Unit: %.
 */
export const FORCED_CONTEXT_REDUCTION_PERCENT = 75

/** Max automatic retries for context-window-exceeded errors before giving up. */
export const MAX_CONTEXT_WINDOW_RETRIES = 3

/**
 * Default ceiling on CONSECUTIVE failed model API requests before a task gives
 * up (setting: `maxConsecutiveApiFailures`). Counts failures with no successful
 * request in between, so a blip mid-task costs nothing; only an unrecoverable
 * condition reaches the ceiling.
 *
 * 6 is chosen against the backoff schedule, which is exponential from
 * `requestDelaySeconds` (default 10s) and capped at
 * {@link MAX_EXPONENTIAL_BACKOFF_SECONDS}: five waits of 10+20+40+80+160s put
 * the give-up at roughly five minutes — long enough to ride out a real provider
 * outage or a rolling restart, short enough that a permanent misconfiguration
 * (an unreachable provider, a proxy denying the host) is reported while someone
 * is still watching. Every attempt is itself retried by the provider SDK, so
 * the real number of network attempts is a small multiple of this.
 */
export const MAX_CONSECUTIVE_API_FAILURES = 6

/** Deadline (ms) to wait for the MCP hub to be ready before skipping the
 * enabled-tool-count warning. */
export const MCP_READY_DEADLINE_MS = 12_000

/** Debounce/emit interval (ms) for throttled token-usage UI updates. */
export const TASK_TOKEN_USAGE_EMIT_INTERVAL_MS = 2000

/**
 * Trailing debounce interval (ms) for `saveShoferMessages`; collapses a burst of
 * per-chunk streaming writes into a single fsync+rename. `maxWait` is derived as
 * a multiple of this at the call site.
 */
export const TASK_SAVE_DEBOUNCE_INTERVAL_MS = 250

/**
 * Minimum interval (ms) between per-chunk partial-message JSONL appends. Partial
 * updates are appended at most once per interval (finalized messages always
 * append) to cut write + compaction churn during streaming.
 */
export const TASK_PARTIAL_APPEND_THROTTLE_MS = 250
