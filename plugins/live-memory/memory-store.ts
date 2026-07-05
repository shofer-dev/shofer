/**
 * MemoryStore — the plugin's persistence layer, built entirely on `ctx.storage`
 * (the P6.G2 per-plugin persistent dir). It is the plugin-native analogue of the
 * built-in Live Memory's `ConversationStore`: a workspace-scoped JSON document of
 * accumulated activity observations and question/answer pairs, persisted under the
 * plugin's own storage sandbox and reloaded across restarts.
 *
 * Where `ConversationStore` writes `<globalStorage>/shofer-live-memory-<hash>.json`
 * directly through `node:fs`, this store writes `memory-<hash>.json` through the
 * traversal-blocked `PluginStorage` surface — the plugin never touches host paths.
 * The `<hash>` is a cheap FNV-1a hash of the workspace path (no `node:crypto`
 * import, so the module stays dependency-free and bundles cleanly), giving each
 * workspace an isolated, bounded-length file.
 */

import type { PluginStorage } from "@shofer/types"

/** Schema version of the persisted document; bump on an incompatible shape change. */
export const MEMORY_STORE_VERSION = 1

/** How the plugin came to know about a file touch. */
export type ObservationKind =
	/** Shofer edited the file via one of its own tools (observed in `afterToolCall`). */
	| "edit"
	/** Shofer read/searched the file via a tool (observed in `afterToolCall`). */
	| "read"
	/** The file changed on disk outside Shofer (observed via `ctx.host.watch`). */
	| "external"
	/** A task-lifecycle marker (observed via `onEvent`). */
	| "task"

/** A single accumulated activity observation. */
export interface Observation {
	/** Epoch ms when observed. */
	at: number
	kind: ObservationKind
	/** Workspace-relative (best-effort) file path, or a marker label for `task`. */
	subject: string
	/** The tool or event that produced the observation, when known. */
	via?: string
	/** A short human-readable note (e.g. a result excerpt), capped by the caller. */
	note?: string
}

/** A retained question and the answer the memory LLM produced. */
export interface QaEntry {
	at: number
	question: string
	answer: string
}

/** Running counters that survive observation/Q&A eviction. */
export interface MemoryStats {
	totalObservations: number
	totalQuestions: number
	/** A compacted running summary produced by the maintenance service (optional). */
	summary?: string
	summaryUpdatedAt?: number
}

/** The persisted document. */
export interface MemoryData {
	version: number
	workspacePath: string
	updatedAt: number
	observations: Observation[]
	qa: QaEntry[]
	stats: MemoryStats
}

export interface MemoryStoreOptions {
	/** Cap on retained observations (older ones evicted FIFO). */
	maxObservations?: number
	/** Cap on retained Q&A pairs (older ones evicted FIFO). */
	maxQuestions?: number
}

/** A stable, dependency-free 32-bit FNV-1a hash rendered as 8 hex chars. */
export function hashWorkspace(workspacePath: string): string {
	let h = 0x811c9dc5
	for (let i = 0; i < workspacePath.length; i++) {
		h ^= workspacePath.charCodeAt(i)
		// FNV prime multiply, kept in 32-bit range via Math.imul.
		h = Math.imul(h, 0x01000193)
	}
	return (h >>> 0).toString(16).padStart(8, "0")
}

function emptyData(workspacePath: string): MemoryData {
	return {
		version: MEMORY_STORE_VERSION,
		workspacePath,
		updatedAt: Date.now(),
		observations: [],
		qa: [],
		stats: { totalObservations: 0, totalQuestions: 0 },
	}
}

/**
 * A workspace-scoped memory document backed by `ctx.storage`. Loads lazily and
 * caches in memory; every mutation is write-through so all plugin hooks (the tool,
 * the prompt transform, the lifecycle observers, the maintenance service) share one
 * coherent, persisted view.
 */
export class MemoryStore {
	private readonly fileName: string
	private readonly maxObservations: number
	private readonly maxQuestions: number
	private cache: MemoryData | undefined

	constructor(
		private readonly storage: PluginStorage,
		private readonly workspacePath: string,
		opts: MemoryStoreOptions = {},
	) {
		this.fileName = `memory-${hashWorkspace(workspacePath)}.json`
		this.maxObservations = Math.max(1, opts.maxObservations ?? 400)
		this.maxQuestions = Math.max(1, opts.maxQuestions ?? 50)
	}

	/** The relative file name under the plugin's storage dir (for diagnostics/tests). */
	get relativePath(): string {
		return this.fileName
	}

	/** Load (once) from storage, tolerating a missing/corrupt/old-version file. */
	async load(): Promise<MemoryData> {
		if (this.cache) return this.cache
		try {
			if (await this.storage.exists(this.fileName)) {
				const raw = await this.storage.readFile(this.fileName)
				const parsed = JSON.parse(raw) as MemoryData
				if (parsed && parsed.version === MEMORY_STORE_VERSION) {
					this.cache = normalize(parsed, this.workspacePath)
					return this.cache
				}
			}
		} catch {
			// Corrupt/unreadable ⇒ start fresh (best-effort, never throws to a hook).
		}
		this.cache = emptyData(this.workspacePath)
		return this.cache
	}

	/** Current in-memory snapshot (loads if needed). */
	async snapshot(): Promise<MemoryData> {
		return this.load()
	}

	/** Append an observation, evict past the cap, and persist. */
	async recordObservation(obs: Observation): Promise<void> {
		const data = await this.load()
		data.observations.push(obs)
		data.stats.totalObservations++
		if (data.observations.length > this.maxObservations) {
			data.observations.splice(0, data.observations.length - this.maxObservations)
		}
		await this.persist(data)
	}

	/** Append a question/answer pair, evict past the cap, and persist. */
	async recordQa(question: string, answer: string): Promise<void> {
		const data = await this.load()
		data.qa.push({ at: Date.now(), question, answer })
		data.stats.totalQuestions++
		if (data.qa.length > this.maxQuestions) {
			data.qa.splice(0, data.qa.length - this.maxQuestions)
		}
		await this.persist(data)
	}

	/** Replace the running summary (used by the maintenance service). */
	async setSummary(summary: string): Promise<void> {
		const data = await this.load()
		data.stats.summary = summary
		data.stats.summaryUpdatedAt = Date.now()
		await this.persist(data)
	}

	private async persist(data: MemoryData): Promise<void> {
		data.updatedAt = Date.now()
		await this.storage.writeFile(this.fileName, JSON.stringify(data, null, "\t"))
	}
}

/** Coerce a loaded document into a well-formed {@link MemoryData} (defensive). */
function normalize(parsed: MemoryData, workspacePath: string): MemoryData {
	const base = emptyData(workspacePath)
	return {
		version: MEMORY_STORE_VERSION,
		workspacePath: parsed.workspacePath ?? workspacePath,
		updatedAt: parsed.updatedAt ?? Date.now(),
		observations: Array.isArray(parsed.observations) ? parsed.observations : base.observations,
		qa: Array.isArray(parsed.qa) ? parsed.qa : base.qa,
		stats: {
			totalObservations: parsed.stats?.totalObservations ?? 0,
			totalQuestions: parsed.stats?.totalQuestions ?? 0,
			summary: parsed.stats?.summary,
			summaryUpdatedAt: parsed.stats?.summaryUpdatedAt,
		},
	}
}
