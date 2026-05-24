/**
 * BlobStore — content-addressable per-task blob storage for inline-content
 * caps and externalisation (§4.3 of `docs/mem-utilization-profiling.md`).
 *
 * Rationale: large tool outputs and other text payloads bloat both
 * `shoferMessages` (UI / persisted JSONL) and `apiConversationHistory`
 * (LLM request body). To keep both representations bounded, any string
 * whose UTF-8 byte length exceeds a configurable cap is written to a
 * content-addressable file under the task's directory and replaced inline
 * with a reference token: `<shofer-blob sha256="..." bytes="N"/>`.
 *
 * - The token is opaque to the UI (rendered as an expandable widget).
 * - At LLM request-build time, refs that survive context-window truncation
 *   are expanded back to the original bytes.
 * - On task deletion, the entire blobs directory is removed.
 *
 * Storage layout: `<taskDir>/blobs/<sha256>.txt`. The store is per-task so
 * GC is trivial; cross-task deduplication is intentionally NOT supported
 * (would require a reference-counted index that is out of scope here).
 */

import * as fs from "fs/promises"
import * as path from "path"
import { createHash } from "crypto"

import { outputError, outputWarn } from "../../utils/outputChannelLogger"

/** Default inline cap (bytes). Overridable via `shoferBlobCapBytes` setting. */
export const DEFAULT_BLOB_CAP_BYTES = 2048

/**
 * Regular expression matching a single blob reference token. Uses `g` so
 * the same instance can be used in `.matchAll()` and `.replace()` calls.
 *
 * Format: `<shofer-blob sha256="<64 hex>" bytes="<digits>"/>` — no spaces
 * inside the self-closing `/>`, matching what `formatRef` emits.
 */
export const BLOB_REF_REGEX = /<shofer-blob sha256="([0-9a-f]{64})" bytes="(\d+)"\/>/g

export interface BlobRef {
	sha256: string
	bytes: number
}

/** Format a blob reference token. */
export function formatBlobRef(ref: BlobRef): string {
	return `<shofer-blob sha256="${ref.sha256}" bytes="${ref.bytes}"/>`
}

/**
 * Extract every blob reference token in `text`. Returned refs preserve
 * source order; duplicates are not deduplicated.
 */
export function extractBlobRefs(text: string): BlobRef[] {
	const refs: BlobRef[] = []
	BLOB_REF_REGEX.lastIndex = 0
	for (const match of text.matchAll(BLOB_REF_REGEX)) {
		refs.push({ sha256: match[1], bytes: Number(match[2]) })
	}
	return refs
}

export class BlobStore {
	/** Absolute path to `<taskDir>/blobs`. */
	public readonly dir: string

	constructor(taskDir: string) {
		this.dir = path.join(taskDir, "blobs")
	}

	private filePath(sha256: string): string {
		return path.join(this.dir, `${sha256}.txt`)
	}

	/**
	 * Write `content` to the content-addressable store and return its ref.
	 * If a blob with the same sha256 already exists on disk, no write is
	 * performed (writes are idempotent).
	 */
	public async write(content: string): Promise<BlobRef> {
		const bytes = Buffer.byteLength(content, "utf8")
		const sha256 = createHash("sha256").update(content, "utf8").digest("hex")
		const filePath = this.filePath(sha256)
		try {
			await fs.mkdir(this.dir, { recursive: true })
			// `wx` flag → fail if file exists, so we avoid rewriting bytes
			// we already have. ENOENT/EEXIST handled below.
			await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" })
		} catch (err) {
			const e = err as NodeJS.ErrnoException
			if (e.code !== "EEXIST") {
				outputError(`[BlobStore.write] Failed to write blob ${sha256}: ${e.message}`)
				throw err
			}
		}
		return { sha256, bytes }
	}

	/** Read a blob's content by sha256, or `undefined` if it is missing. */
	public async read(sha256: string): Promise<string | undefined> {
		try {
			return await fs.readFile(this.filePath(sha256), "utf8")
		} catch (err) {
			const e = err as NodeJS.ErrnoException
			if (e.code === "ENOENT") return undefined
			outputWarn(`[BlobStore.read] Failed to read blob ${sha256}: ${e.message}`)
			return undefined
		}
	}

	/**
	 * If `text` exceeds `capBytes`, write the full payload to a blob and
	 * return a single reference token. Otherwise return `text` unchanged.
	 *
	 * Text already consisting entirely of a single reference token is
	 * returned as-is (avoid double-externalising).
	 */
	public async externalizeIfOverCap(text: string, capBytes: number): Promise<string> {
		if (!text || capBytes <= 0) return text
		if (Buffer.byteLength(text, "utf8") <= capBytes) return text
		// Avoid re-wrapping an already-externalised payload.
		if (/^<shofer-blob sha256="[0-9a-f]{64}" bytes="\d+"\/>$/.test(text.trim())) return text
		const ref = await this.write(text)
		return formatBlobRef(ref)
	}

	/**
	 * Replace every blob ref token in `text` with the corresponding blob
	 * content. Missing blobs are rendered as a visible banner so the
	 * caller (LLM, UI) sees that bytes were lost rather than silently
	 * dropping them.
	 */
	public async resolveRefs(text: string): Promise<string> {
		if (!text || !text.includes("<shofer-blob ")) return text
		const refs = extractBlobRefs(text)
		if (refs.length === 0) return text
		// Read once per unique sha256.
		const cache = new Map<string, string | undefined>()
		for (const { sha256 } of refs) {
			if (!cache.has(sha256)) {
				cache.set(sha256, await this.read(sha256))
			}
		}
		BLOB_REF_REGEX.lastIndex = 0
		return text.replace(BLOB_REF_REGEX, (_match, sha256: string, bytes: string) => {
			const content = cache.get(sha256)
			if (content === undefined) {
				return `[shofer-blob ${sha256.slice(0, 12)}… missing (${bytes} bytes)]`
			}
			return content
		})
	}

	/** Delete the entire per-task blob directory (best-effort). */
	public async deleteAll(): Promise<void> {
		try {
			await fs.rm(this.dir, { recursive: true, force: true })
		} catch (err) {
			const e = err as NodeJS.ErrnoException
			outputWarn(`[BlobStore.deleteAll] ${this.dir}: ${e.message}`)
		}
	}
}
