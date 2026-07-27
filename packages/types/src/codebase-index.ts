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

/**
 * The indexer's own settings (provider, model, store URL, credentials) are NOT here any
 * more: they are the `rag-indexing` plugin's manifest `config`, declared in
 * `plugins/rag-indexing/plugin.json`. What stays is what the rest of the product shares —
 * the policy lists above (the glob service and tree-sitter re-export them) and the
 * on-disk cache format below, which is the plugin's but is versioned like every other
 * persisted snapshot.
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
