/**
 * RAG Indexing — semantic search over the codebase and its git history, as a bundled
 * Shofer plugin.
 *
 * Two indexes, one plugin, because they are one feature wearing two hats: they share the
 * embedder, the vector store, the credentials and the settings UI. Splitting them would
 * mean two copies of the provider layer and two places to configure the same Qdrant.
 *
 * What the plugin owns:
 *
 * | Piece                                    | Where                                       |
 * | ---------------------------------------- | ------------------------------------------- |
 * | embedders, vector store, chunking        | `src/engine/`                               |
 * | scan / watch / cache / state             | `src/indexing/`, `src/cache-manager.ts`     |
 * | git-history index                        | `src/git-index-service/`                    |
 * | `rag_search` + `git_search`              | `registerTools` below                       |
 * | its settings and credentials             | `plugin.json` `config` (`secret: true`)     |
 * | the settings panel + the status chip     | `ui/`                                       |
 *
 * What core keeps: nothing about indexing at all. `ctx.host.search` still answers
 * `ragSearch`/`gitSearch` for other plugins (Live Memory), but the host now asks THIS
 * plugin for the results.
 *
 * **Search-only hosts.** A host provisioned with `searchOnly: true` (plus the shared
 * `indexKey`) queries the shared store and never scans — one writer, many readers.
 * The config arrives like any other plugin config (the layered `.shofer/` files).
 */

import { defineCustomTool, parametersSchema as z } from "@shofer/types"
import type { PluginContext, ShoferPlugin } from "@shofer/types"

import { CodeIndexManager } from "./manager.js"
import { GitIndexManager } from "./git-index-service/git-index-manager.js"
import { loadEnablement } from "./enablement.js"
import { codeIndexLog } from "./logging.js"
import { bindRuntime, setting } from "./plugin-runtime.js"

const PLUGIN_NAME = "rag-indexing"

/** Cap on hits returned to the model — every hit becomes tokens in the next turn. */
const CODE_SEARCH_CAP = { default: 10, max: 50 }
const GIT_SEARCH_CAP = { default: 20, max: 50 }

interface Managers {
	code?: CodeIndexManager
	git?: GitIndexManager
}

const managers: Managers = {}

/** Clamp whatever the model asked for into `[1, cap.max]`, defaulting when it asked for nothing. */
function resolveMaxResults(requested: number | null | undefined, cap: { default: number; max: number }): number {
	const value = Number(requested)
	if (!Number.isFinite(value) || value < 1) return cap.default
	return Math.min(Math.floor(value), cap.max)
}

/** "Showing first N of more results." — the honest header when a cap truncated the answer. */
function truncationHeader(shown: number, truncated: boolean): string {
	return truncated ? `Showing first ${shown} results. More matches existed.\n\n` : ""
}

const plugin: ShoferPlugin = {
	name: PLUGIN_NAME,

	async initialize(ctx: PluginContext): Promise<void> {
		bindRuntime(ctx)
		await loadEnablement()

		const storageDir = ctx.storage?.dir
		const workspace = ctx.workspacePath ?? ctx.cwd
		if (!storageDir || !workspace) {
			// Nowhere to keep the cache, or nothing to index: the tools stay unregistered
			// rather than failing per call.
			codeIndexLog.warn("initialize: no storage or workspace — the index stays off")
			return
		}

		managers.code = CodeIndexManager.getInstance(storageDir, workspace)
		managers.git = GitIndexManager.getInstance(storageDir, workspace)

		// The watchers, the batch timers and the embedder queues are the plugin's, so they
		// stop when it does — a disabled indexer that kept watching would keep embedding.
		ctx.registerService?.({
			name: "rag-indexing",
			start: () => {},
			stop: () => {
				managers.code?.dispose()
				managers.git?.dispose()
				managers.code = undefined
				managers.git = undefined
			},
		})

		// Indexing is long-running and failure-prone (an embedder that is down, a store
		// that moved); it must never take plugin activation with it.
		void managers.code?.initialize().catch((error: unknown) => {
			codeIndexLog.error(`code index initialize failed: ${String(error)}`)
		})
		if (setting("gitIndexEnabled", false)) {
			void managers.git?.initialize().catch((error: unknown) => {
				codeIndexLog.error(`git index initialize failed: ${String(error)}`)
			})
		}
	},

	/**
	 * The agent-facing half.
	 *
	 * Both tools are registered only when their index can actually answer — a tool that
	 * exists but always replies "indexing is not configured" costs a slot in every system
	 * prompt and teaches the model to ignore it.
	 */
	async registerTools() {
		const tools = []

		if (managers.code?.isFeatureEnabled && managers.code.isInitialized) {
			tools.push(
				defineCustomTool({
					name: "rag_search",
					description:
						"Semantic search across the indexed codebase. Finds code by meaning rather than by literal text — use it when you know what something DOES but not what it is called. Prefer grep_search for exact strings.",
					group: "read",
					parameters: z.object({
						query: z.string().describe("What to look for, in natural language."),
						path: z.string().optional().describe("Restrict results to this directory prefix."),
						maxResults: z
							.number()
							.optional()
							.describe(`Maximum hits (default ${CODE_SEARCH_CAP.default}).`),
					}),
					async execute({ query, path: directoryPrefix, maxResults }) {
						const limit = resolveMaxResults(maxResults, CODE_SEARCH_CAP)
						const results = await managers.code!.searchIndex(query, directoryPrefix, limit + 1)
						const shown = results.slice(0, limit)
						if (shown.length === 0) return "No matches in the code index."
						return (
							truncationHeader(shown.length, results.length > limit) +
							shown
								.map((result) => {
									const payload = result.payload
									const location = `${payload?.filePath ?? "?"}:${payload?.startLine ?? 0}-${payload?.endLine ?? 0}`
									return `${location} (score ${result.score?.toFixed(3) ?? "?"})\n${payload?.codeChunk ?? ""}`
								})
								.join("\n\n")
						)
					},
				}),
			)
		}

		if (managers.git?.isFeatureEnabled && managers.git.isInitialized) {
			tools.push(
				defineCustomTool({
					name: "git_search",
					description:
						"Semantic search across this repository's commit messages. Answers 'when and why did this change', which the code index cannot — it only knows the current state of the tree.",
					group: "read",
					parameters: z.object({
						query: z.string().describe("What to look for, in natural language."),
						maxResults: z.number().optional().describe(`Maximum hits (default ${GIT_SEARCH_CAP.default}).`),
					}),
					async execute({ query, maxResults }) {
						const limit = resolveMaxResults(maxResults, GIT_SEARCH_CAP)
						const results = await managers.git!.searchIndex(query, limit + 1)
						const shown = results.slice(0, limit)
						if (shown.length === 0) return "No matches in the git history index."
						return (
							truncationHeader(shown.length, results.length > limit) +
							shown
								.map(
									(result) =>
										`${result.payload.short_hash} ${result.payload.author_date} ${result.payload.author}\n` +
										`${result.payload.subject}\n${result.payload.body}`.trim(),
								)
								.join("\n\n")
						)
					},
				}),
			)
		}

		return tools
	},

	/**
	 * The UI's request surface, plus the two questions the host asks.
	 *
	 * `search` / `git-search` are how `ctx.host.search` reaches this plugin: core no longer
	 * has an index to query, so its seam forwards here and other plugins (Live Memory) go
	 * on working unchanged.
	 */
	async handleRequest(method: string, params: unknown): Promise<unknown> {
		switch (method.replace(/^local:/, "")) {
			// ── what core asks ───────────────────────────────────────────────────
			case "search": {
				const { query, directoryPrefix, maxResults } = params as {
					query: string
					directoryPrefix?: string
					maxResults?: number
				}
				if (!managers.code?.isFeatureEnabled || !managers.code.isInitialized) return []
				return managers.code.searchIndex(query, directoryPrefix, maxResults)
			}

			case "git-search": {
				const { query, maxResults } = params as { query: string; maxResults?: number }
				if (!managers.git?.isFeatureEnabled || !managers.git.isInitialized) return []
				return managers.git.searchIndex(query, maxResults)
			}

			/**
			 * Embeddings for another plugin (`ctx.ai.embed`).
			 *
			 * The host's AI seam has no embedder of its own — the provider, the model and
			 * the key are this plugin's configuration — so it forwards here. Throws when
			 * nothing is configured rather than returning an empty array: a caller that
			 * silently got no vectors would store garbage.
			 */
			case "embed": {
				const { texts } = params as { texts: string[] }
				const embedder = managers.code?.createEmbedderForHost()
				if (!embedder) throw new Error("rag-indexing: embeddings are not configured")
				const { embeddings } = await embedder.createEmbeddings(texts)
				return embeddings
			}

			// ── what the plugin's own UI asks ────────────────────────────────────
			case "status":
				return {
					code: managers.code?.getCurrentStatus(),
					git: managers.git?.getCurrentStatus(),
				}

			case "start-indexing":
				await managers.code?.startIndexing()
				return { started: true }

			case "stop-indexing":
				managers.code?.stopIndexing()
				return { stopped: true }

			case "clear-index":
				await managers.code?.clearIndexData()
				return { cleared: true }

			case "set-workspace-enabled": {
				const { enabled } = params as { enabled: boolean }
				await managers.code?.setWorkspaceEnabled(enabled)
				return { enabled }
			}

			case "settings-changed":
				await managers.code?.handleSettingsChange()
				await managers.git?.handleSettingsChange()
				return { applied: true }

			default:
				throw new Error(`${PLUGIN_NAME}: unknown request method "${method}"`)
		}
	},
}

export default plugin
