/**
 * Where the tree-sitter grammars live.
 *
 * The `.wasm` files are 62 MB and they ship with the extension already — core parses code
 * with them for `list_code_definition_names`. Shipping a second copy inside this plugin
 * would double that for no benefit, so the plugin **borrows the host's**.
 *
 * Finding them is a search upward from this module for the directory that holds
 * `tree-sitter.wasm`, because the answer differs by how the plugin was loaded:
 *
 * - bundled and shipped: `…/dist/plugins/rag-indexing/main.mjs` → grammars in `…/dist/`
 * - loaded from source in the repo: `…/plugins/rag-indexing/src/…` → grammars in
 *   `…/src/dist/`, which is the extension's build output
 *
 * Resolved once and cached. When nothing is found the parser falls back to line-based
 * chunking (`loadRequiredLanguageParsers` throws, and the caller already treats that as
 * "this file is not parseable"), so a missing grammar directory degrades the index rather
 * than breaking it — and says so in the log, since silently line-chunking an entire
 * repository looks like bad embeddings rather than a missing asset.
 */

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

import { codeIndexLog } from "./logging.js"

/** How far up to look before giving up — enough for either layout, not the whole disk. */
const MAX_DEPTH = 8

let resolved: string | undefined | null = null

function findGrammarDir(start: string): string | undefined {
	let dir = start
	for (let depth = 0; depth < MAX_DEPTH; depth++) {
		if (fs.existsSync(path.join(dir, "tree-sitter.wasm"))) return dir
		// The extension's build output, when we started inside the repo's `plugins/`.
		const dist = path.join(dir, "src", "dist")
		if (fs.existsSync(path.join(dist, "tree-sitter.wasm"))) return dist
		const parent = path.dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return undefined
}

/**
 * The directory holding `tree-sitter.wasm` and the per-language grammars, or `undefined`
 * when the host ships none (every file then falls back to line-based chunking).
 */
export function grammarDirectory(): string | undefined {
	if (resolved !== null) return resolved
	const here = path.dirname(fileURLToPath(import.meta.url))
	resolved = findGrammarDir(here)
	if (!resolved) {
		codeIndexLog.warn(
			`[grammars] no tree-sitter grammars found above ${here} — files will be chunked by line, not by syntax`,
		)
	}
	return resolved
}
