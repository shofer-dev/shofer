import { z } from "zod"

/**
 * Codebase Index Constants
 */
export const CODEBASE_INDEX_DEFAULTS = {
	MIN_SEARCH_RESULTS: 10,
	MAX_SEARCH_RESULTS: 200,
	DEFAULT_SEARCH_RESULTS: 50,
	SEARCH_RESULTS_STEP: 10,
	MIN_SEARCH_SCORE: 0,
	MAX_SEARCH_SCORE: 1,
	DEFAULT_SEARCH_MIN_SCORE: 0.4,
	SEARCH_SCORE_STEP: 0.05,
} as const

/**
 * File extensions whose contents the codebase indexer ingests. A file is only
 * picked up by the scanner / file-watcher if its extension is in this list AND
 * it passes the workspace's .gitignore / .shoferignore rules AND is not under
 * a directory in {@link CODEBASE_INDEX_IGNORED_DIRS}. The list is also the
 * source-of-truth for the tree-sitter parser's supported languages — see
 * `src/services/tree-sitter/index.ts` which re-exports it as `extensions`.
 */
export const CODEBASE_INDEX_FILE_EXTENSIONS: readonly string[] = [
	".tla",
	".js",
	".jsx",
	".ts",
	".vue",
	".tsx",
	".py",
	".rs",
	".go",
	".c",
	".h",
	".cpp",
	".hpp",
	".cs",
	".rb",
	".java",
	".php",
	".swift",
	".sol",
	".kt",
	".kts",
	".ex",
	".exs",
	".el",
	".html",
	".htm",
	".md",
	".markdown",
	".json",
	".css",
	".rdl",
	".ml",
	".mli",
	".lua",
	".scala",
	".toml",
	".zig",
	".elm",
	".ejs",
	".erb",
	".vb",
] as const

/**
 * Directory name patterns that the codebase indexer (and the general file-
 * listing service) skips wholesale. Matched against any path component:
 * an exact equality check, except for `.*` which matches any dotfile / hidden
 * directory. Used by `services/glob/ignore-utils.ts::isPathInIgnoredDirectory`
 * (re-exported from `services/glob/constants.ts` as `DIRS_TO_IGNORE`) and
 * surfaced read-only in the Settings UI's RAG → Advanced Configuration panel.
 */
export const CODEBASE_INDEX_IGNORED_DIRS: readonly string[] = [
	"node_modules",
	"__pycache__",
	"env",
	"venv",
	"dist",
	"build",
	"out",
	"target",
	"coverage",
	".next",
	"bundle",
	"vendor",
	"tmp",
	"temp",
	"deps",
	"pkg",
	"Pods",
	".git",
	".*",
] as const

/**
 * CodebaseIndexConfig
 */

export const codebaseIndexConfigSchema = z.object({
	codebaseIndexEnabled: z.boolean().optional(),
	codebaseIndexQdrantUrl: z.string().optional(),
	codebaseIndexEmbedderProvider: z
		.enum([
			"openai",
			"ollama",
			"openai-compatible",
			"gemini",
			"mistral",
			"vercel-ai-gateway",
			"bedrock",
			"openrouter",
		])
		.optional(),
	codebaseIndexEmbedderBaseUrl: z.string().optional(),
	codebaseIndexEmbedderModelId: z.string().optional(),
	codebaseIndexEmbedderModelDimension: z.number().optional(),
	codebaseIndexSearchMinScore: z.number().min(0).max(1).optional(),
	codebaseIndexSearchMaxResults: z
		.number()
		.min(CODEBASE_INDEX_DEFAULTS.MIN_SEARCH_RESULTS)
		.max(CODEBASE_INDEX_DEFAULTS.MAX_SEARCH_RESULTS)
		.optional(),
	// OpenAI Compatible specific fields
	codebaseIndexOpenAiCompatibleBaseUrl: z.string().optional(),
	codebaseIndexOpenAiCompatibleModelDimension: z.number().optional(),
	// Bedrock specific fields
	codebaseIndexBedrockRegion: z.string().optional(),
	codebaseIndexBedrockProfile: z.string().optional(),
	// OpenRouter specific fields
	codebaseIndexOpenRouterSpecificProvider: z.string().optional(),
	// Git history indexing fields
	codebaseIndexGitEnabled: z.boolean().optional(),
	codebaseIndexGitPollIntervalMinutes: z.number().optional(),
	codebaseIndexGitMaxHistoryDays: z.number().optional(),
	codebaseIndexGitMaxCommits: z.number().optional(),
	codebaseIndexGitSearchMinScore: z.number().min(0).max(1).optional(),
	codebaseIndexGitBranch: z.string().optional(),
	codebaseIndexGitSearchMaxResults: z.number().optional(),
})

export type CodebaseIndexConfig = z.infer<typeof codebaseIndexConfigSchema>

/**
 * CodebaseIndexModels
 */

export const codebaseIndexModelsSchema = z.object({
	openai: z.record(z.string(), z.object({ dimension: z.number() })).optional(),
	ollama: z.record(z.string(), z.object({ dimension: z.number() })).optional(),
	"openai-compatible": z.record(z.string(), z.object({ dimension: z.number() })).optional(),
	gemini: z.record(z.string(), z.object({ dimension: z.number() })).optional(),
	mistral: z.record(z.string(), z.object({ dimension: z.number() })).optional(),
	"vercel-ai-gateway": z.record(z.string(), z.object({ dimension: z.number() })).optional(),
	openrouter: z.record(z.string(), z.object({ dimension: z.number() })).optional(),
	bedrock: z.record(z.string(), z.object({ dimension: z.number() })).optional(),
})

export type CodebaseIndexModels = z.infer<typeof codebaseIndexModelsSchema>

/**
 * CdebaseIndexProvider
 */

export const codebaseIndexProviderSchema = z.object({
	codeIndexOpenAiKey: z.string().optional(),
	codeIndexQdrantApiKey: z.string().optional(),
	codebaseIndexOpenAiCompatibleBaseUrl: z.string().optional(),
	codebaseIndexOpenAiCompatibleApiKey: z.string().optional(),
	codebaseIndexOpenAiCompatibleModelDimension: z.number().optional(),
	codebaseIndexGeminiApiKey: z.string().optional(),
	codebaseIndexMistralApiKey: z.string().optional(),
	codebaseIndexVercelAiGatewayApiKey: z.string().optional(),
	codebaseIndexOpenRouterApiKey: z.string().optional(),
})

export type CodebaseIndexProvider = z.infer<typeof codebaseIndexProviderSchema>

/**
 * Codebase Index Cache (Phase 1: versioned mtime+size cache)
 *
 * Per the Versioned Snapshot Rule, the on-disk cache is wrapped in a
 * versioned container. On version mismatch or parse failure the cache
 * is discarded and a fresh full scan is triggered.
 *
 * CacheEntry stores the file hash, mtime (ms), and size (bytes) so the
 * scanner can skip files whose mtime+size match without reading or
 * hashing the contents.
 */
export const codebaseIndexCacheEntrySchema = z.object({
	hash: z.string(),
	mtimeMs: z.number(),
	size: z.number(),
	segmentHashes: z.array(z.string()),
})

export type CodebaseIndexCacheEntry = z.infer<typeof codebaseIndexCacheEntrySchema>

export const codebaseIndexCacheSchema = z.object({
	version: z.literal(3),
	entries: z.record(z.string(), codebaseIndexCacheEntrySchema),
})

export type CodebaseIndexCache = z.infer<typeof codebaseIndexCacheSchema>
