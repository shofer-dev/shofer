/**
 * plugin-search — the read-only **index / symbol / diagnostics search** capability
 * handed to a plugin via `ctx.host.search` (design §6.11; the `ctx.host.search` seam).
 *
 * A plugin granted `permissions.search` gets a live {@link PluginSearch} that can query
 * the host's code index (`ragSearch`), git history (`gitSearch`), workspace symbols
 * (`codeUsages`), and diagnostics (`diagnostics`) — the same providers the built-in Live
 * Memory's `rag_search` / `git_search` / `list_code_usages` / `get_errors` reach. Those
 * providers are VS Code-only with no other plugin seam, so this exposes them to plugins
 * as plain DTOs without leaking `vscode` types.
 *
 * The *querying* is host-side (it needs the extension's `CodeIndexManager` /
 * `GitIndexManager` / `vscode.languages` / symbol provider), so `@shofer/core` stays
 * host-agnostic by consuming a {@link PluginSearchProvider} seam the extension/CLI
 * supplies — mirroring {@link PluginAiProvider} / {@link PluginAgentProvider}. Two states:
 * - `permissions.search` granted ⇒ {@link createPluginSearch}: delegates to the host seam.
 * - `permissions.search` ungranted (but the host wired the seam) ⇒ {@link
 *   createDeniedPluginSearch}: every call throws + warns.
 *
 * When the host wires **no** search seam (headless/pure-core), the manager omits
 * `ctx.host.search` entirely — there is nothing to query.
 *
 * Read-only and side-effect-free, so — unlike {@link PluginAi} — there is no billed-calls
 * consent: the manifest grant alone gates it.
 */

import type {
	HostDiagnostic,
	HostSymbol,
	PluginCodeUsagesOptions,
	PluginGitSearchOptions,
	PluginGitSearchResult,
	PluginRagSearchOptions,
	PluginRagSearchResult,
	PluginSearch,
} from "@shofer/types"

import { warnPlugin } from "./plugin-warnings.js"

/**
 * Host seam that runs a plugin's `ctx.host.search` queries (design §6.11). Supplied by the
 * extension/CLI where `CodeIndexManager` / `GitIndexManager` / the symbol provider /
 * `vscode.languages.getDiagnostics` live, so core never imports them. Every method is
 * fail-soft on the host side: an absent/unconfigured backing service returns an empty
 * result (never throws), so the plugin can probe capabilities without special-casing.
 */
export interface PluginSearchProvider {
	/** Semantic code-index search (host `CodeIndexManager.searchIndex`), mapped to DTOs. */
	ragSearch(query: string, opts?: PluginRagSearchOptions): Promise<PluginRagSearchResult[]>
	/** Semantic git-history search (host `GitIndexManager.searchIndex`), mapped to DTOs. */
	gitSearch(query: string, opts?: PluginGitSearchOptions): Promise<PluginGitSearchResult[]>
	/** Workspace symbols matching `symbol` (host `executeWorkspaceSymbolProvider`). */
	codeUsages(symbol: string, opts?: PluginCodeUsagesOptions): Promise<HostSymbol[]>
	/** Current workspace diagnostics (host `languages.getDiagnostics`), optionally path-filtered. */
	diagnostics(path?: string): Promise<HostDiagnostic[]>
}

/**
 * The live {@link PluginSearch} for a granted plugin: delegates to the host
 * {@link PluginSearchProvider}. Errors from the provider are surfaced to the plugin (it
 * awaits the promise) and additionally warned so a misconfigured host is visible in the log.
 */
export function createPluginSearch(pluginName: string, provider: PluginSearchProvider): PluginSearch {
	const guard = async <T>(op: string, run: () => Promise<T>): Promise<T> => {
		try {
			return await run()
		} catch (error) {
			warnPlugin(`[plugin:${pluginName}] ctx.host.search.${op} failed: ${String(error)}`)
			throw error
		}
	}
	return {
		ragSearch: (query, opts) => guard("ragSearch", () => provider.ragSearch(query, opts)),
		gitSearch: (query, opts) => guard("gitSearch", () => provider.gitSearch(query, opts)),
		codeUsages: (symbol, opts) => guard("codeUsages", () => provider.codeUsages(symbol, opts)),
		diagnostics: (path) => guard("diagnostics", () => provider.diagnostics(path)),
	}
}

/**
 * The **denying** {@link PluginSearch} for a plugin that did **not** request
 * `permissions.search` (design §8). Every call throws a descriptive error and emits a
 * shown + logged warning — the plugin fails loudly rather than silently reaching the host's
 * index/symbol/diagnostics providers. Distinct from an *absent* `ctx.host.search` (no host
 * seam): here the field is present so a plugin author gets a clear "not granted" error
 * rather than a missing API.
 */
export function createDeniedPluginSearch(
	pluginName: string,
	warn: (message: string) => void = warnPlugin,
): PluginSearch {
	const deny = (op: string): never => {
		const message =
			`[plugin:${pluginName}] ctx.host.search.${op} denied — the plugin declares no permissions.search grant. ` +
			`Add "search": true to the manifest permissions to query the host's index/symbols/diagnostics.`
		warn(message)
		throw new Error(message)
	}
	return {
		// `async` so each throw surfaces as a rejected promise (matching the
		// `Promise`-returning contract), not a synchronous throw at the call site.
		async ragSearch() {
			return deny("ragSearch")
		},
		async gitSearch() {
			return deny("gitSearch")
		},
		async codeUsages() {
			return deny("codeUsages")
		},
		async diagnostics() {
			return deny("diagnostics")
		},
	}
}
