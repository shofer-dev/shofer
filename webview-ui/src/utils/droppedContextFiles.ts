/**
 * Helpers for converting a raw drag-and-drop payload (text/uri-list,
 * text/plain, application/vnd.code.uri-list) coming from VSCode's Explorer
 * or editor tabs into the {path, isFile} entries that the chat UI tracks
 * as "dropped context files".
 *
 * Used by both:
 *  - ChatView's webview-root drop handler (works on code-server / VSCode Web).
 *  - ChatTextArea's textarea drop handler (the only target VSCode Desktop's
 *    cross-origin webview overlay actually delivers drag events to).
 */

export interface DroppedContextFile {
	path: string
	isFile: boolean
}

/**
 * Pull the first non-empty drag payload out of a DataTransfer in priority
 * order.  Returns `null` if no usable payload is present (e.g. a pure-image
 * drop, which is handled separately).
 */
export function extractUriPayload(dataTransfer: DataTransfer): string | null {
	const candidates: Array<{ mime: string; desc: string }> = [
		{ mime: "text/uri-list", desc: "standard URI list" },
		{ mime: "application/vnd.code.tree.explorer", desc: "VSCode Explorer tree drag (primary)" },
		{ mime: "text", desc: "text/plain (Shift+drop on VSCode Desktop)" },
		{ mime: "application/vnd.code.uri-list", desc: "VSCode URI list" },
		{ mime: "application/vnd.code.uri", desc: "VSCode single URI" },
		{ mime: "text/x-moz-url", desc: "Mozilla URL format (Alt+drag fallback)" },
		{ mime: "text/plain", desc: "explicit text/plain" },
	]
	for (const { mime } of candidates) {
		try {
			const val = dataTransfer.getData(mime)
			if (val && val.trim().length > 0) return val
		} catch {
			// Some MIME types may throw in cross-origin contexts; skip.
		}
	}
	return null
}

/**
 * Parse a drag payload into normalised, workspace-relative DroppedContextFile
 * entries, skipping anything already present in `existing` so the caller can
 * safely append the result.
 */
export function parseDroppedUris(
	payload: string,
	cwd: string | undefined,
	existing: ReadonlyArray<DroppedContextFile>,
): DroppedContextFile[] {
	const lines = payload
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0)

	const out: DroppedContextFile[] = []

	for (const line of lines) {
		// Try parsing as a file:// URI first; fall back to treating the line
		// as a raw filesystem path (text/plain and vnd.code.uri-list both do
		// this in practice).
		let absPath: string
		try {
			const uri = new URL(line)
			absPath = decodeURIComponent(uri.pathname)
			// Strip the leading slash from Windows-style /C:/foo paths.
			if (/^\/[a-zA-Z]:/.test(absPath)) {
				absPath = absPath.slice(1)
			}
		} catch {
			absPath = line.trim()
			if (!absPath) continue
		}

		let relativePath: string
		if (cwd && absPath.startsWith(cwd)) {
			const rel = absPath.slice(cwd.length)
			relativePath = rel.startsWith("/") ? rel : "/" + rel
		} else {
			relativePath = absPath
		}

		const dup = existing.some((f) => f.path === relativePath) || out.some((f) => f.path === relativePath)
		if (dup) continue

		// Best-effort heuristic; it only affects the icon shown in the tag.
		const isFile = /\.[a-zA-Z0-9]{1,10}$/.test(relativePath.split("/").pop() || "")
		out.push({ path: relativePath, isFile })
	}

	return out
}
