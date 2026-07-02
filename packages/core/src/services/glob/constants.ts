import { CODEBASE_INDEX_IGNORED_DIRS } from "@shofer/types"

/**
 * List of directories that are typically large and should be ignored
 * when showing recursive file listings or scanning for code indexing.
 * Single source of truth lives in `@shofer/types/codebase-index.ts` so the
 * webview Settings UI can render the same patterns it actually enforces.
 */
export const DIRS_TO_IGNORE: readonly string[] = CODEBASE_INDEX_IGNORED_DIRS
