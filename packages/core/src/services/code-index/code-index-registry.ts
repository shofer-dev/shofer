/**
 * Host-agnostic registry for the Category II `CodeIndexManager` (VS Code `src`).
 *
 * Mirrors the {@link ../mcp/mcp-hub-factory} seam: the concrete manager needs a
 * `vscode.ExtensionContext`, so the portable core must not import it. Core-resident
 * callers — `RagSearchTool`, `build-tools`, `filter-tools-for-mode` — reach the
 * manager through this registered factory instead.
 *
 * The VS Code extension registers a factory at activation (wrapping the manager's
 * static `getInstance`). A host that never runs that activation leaves it unset and
 * the getter returns `undefined`, so code indexing / rag_search is simply off.
 *
 * `shofer serve` is NOT such a host: it loads the same extension bundle via
 * `ExtensionHost.activate()`, so a served node registers this factory and gets a real
 * manager. A node is held to querying — never indexing — by `codebaseIndexSearchOnly`
 * on the controller-synced config, not by this seam.
 */
import type { VectorStoreSearchResult } from "./interfaces/vector-store.js"

/**
 * The narrow slice of the concrete `CodeIndexManager` the portable core reads.
 * Captures ONLY the members the core-resident callers use.
 */
export interface CodeIndexManagerLike {
	readonly isFeatureEnabled: boolean
	readonly isFeatureConfigured: boolean
	readonly isInitialized: boolean
	searchIndex(query: string, directoryPrefix?: string, maxResults?: number): Promise<VectorStoreSearchResult[]>
}

/**
 * Factory mirroring `CodeIndexManager.getInstance(context, workspacePath?)`. The
 * opaque `context` is cast back to `vscode.ExtensionContext` in the adapter.
 */
export type CodeIndexManagerFactory = (context: unknown, workspacePath?: string) => CodeIndexManagerLike | undefined

let factory: CodeIndexManagerFactory | undefined

/** Registers the host factory used to reach the code-index manager singleton. */
export function setCodeIndexManagerFactory(f: CodeIndexManagerFactory): void {
	factory = f
}

/** Returns the registered code-index factory, or `undefined` when unset (headless = feature off). */
export function getCodeIndexManagerFactory(): CodeIndexManagerFactory | undefined {
	return factory
}
