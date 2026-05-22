import { CODEBASE_INDEX_DEFAULTS } from "@shofer/types"

/**Parser */
export const MAX_BLOCK_CHARS = 1000
// Lowered from 50 so that small but meaningful files (short docs, single-
// function snippets, freshly created scratch files) still produce at least
// one chunk and become searchable. Anything below ~10 chars is almost
// always noise (an empty file, a trailing newline, a placeholder) and
// safe to drop on the floor.
export const MIN_BLOCK_CHARS = 10
export const MIN_CHUNK_REMAINDER_CHARS = 200 // Minimum characters for the *next* chunk after a split
export const MAX_CHARS_TOLERANCE_FACTOR = 1.15 // 15% tolerance for max chars

/**Search */
export const DEFAULT_SEARCH_MIN_SCORE = CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_MIN_SCORE
export const DEFAULT_MAX_SEARCH_RESULTS = CODEBASE_INDEX_DEFAULTS.DEFAULT_SEARCH_RESULTS

/**File Watcher */
export const QDRANT_CODE_BLOCK_NAMESPACE = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
export const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024 // 1MB

/**Directory Scanner */
export const MAX_LIST_FILES_LIMIT_CODE_INDEX = 50_000
export const BATCH_SEGMENT_THRESHOLD = 60 // Number of code segments to batch for embeddings/upserts
export const MAX_BATCH_RETRIES = 3
export const INITIAL_RETRY_DELAY_MS = 500
export const PARSING_CONCURRENCY = 10
export const MAX_PENDING_BATCHES = 20 // Maximum number of batches to accumulate before waiting

/**Service Recovery — retry with exponential backoff when the infrastructure
 * (Ollama, Qdrant) is temporarily unreachable. These govern retries at the
 * orchestrator/manager level — not the per-batch retries above.
 *
 * `MAX_SERVICE_ATTEMPTS` is the *total* number of invocations (not retries
 * after the first); with 5 attempts the helper sleeps 4 times: 2s → 4s → 8s
 * → 16s, ≈ 30s of backoff total. */
export const MAX_SERVICE_ATTEMPTS = 5
export const SERVICE_INITIAL_RETRY_DELAY_MS = 2000
export const SERVICE_MAX_BACKOFF_MS = 60000

/**OpenAI Embedder */
export const MAX_BATCH_TOKENS = 100000
export const MAX_ITEM_TOKENS = 8191
export const BATCH_PROCESSING_CONCURRENCY = 10

/**Gemini Embedder */
export const GEMINI_MAX_ITEM_TOKENS = 2048
