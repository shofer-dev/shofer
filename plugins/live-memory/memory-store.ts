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

import { createHash } from "node:crypto"
import { resolve as resolvePath } from "node:path"

import type {
	PluginStorage,
	HostFileSystem,
	AgentMessage,
	FileContextEntry,
	LiveMemoryCostTracking,
} from "@shofer/types"

/**
 * Schema version of the persisted document; bump on an incompatible shape change.
 *
 * v2 grew the document (alongside the existing observations/qa/stats) to also persist
 * the memory agent's conversation `messages`, loaded `fileContexts`, and running
 * `costTracking` — mirroring the built-in `ConversationStore` schema so a later stage
 * can run the full agent-loop Q&A on the plugin surface. Loads stay backward-tolerant:
 * a v1 document (without those fields) is upgraded in place with empty defaults.
 */
export const MEMORY_STORE_VERSION = 2

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
	/**
	 * The memory agent's conversation transcript (added in v2). Mirrors
	 * `ConversationStore.messages`; used by the agent-loop Q&A in a later stage.
	 */
	messages: AgentMessage[]
	/**
	 * File context entries the memory agent has loaded (added in v2). Mirrors
	 * `ConversationStore.fileContexts`; validated on load against the workspace.
	 */
	fileContexts: FileContextEntry[]
	/** Running cost ledger (added in v2). Mirrors `ConversationStore.costTracking`. */
	costTracking: LiveMemoryCostTracking
}

/** The conversation slice persisted alongside the observation/Q&A log (v2). */
export interface ConversationSnapshot {
	messages: AgentMessage[]
	fileContexts: FileContextEntry[]
	costTracking: LiveMemoryCostTracking
}

export interface MemoryStoreOptions {
	/** Cap on retained observations (older ones evicted FIFO). */
	maxObservations?: number
	/** Cap on retained Q&A pairs (older ones evicted FIFO). */
	maxQuestions?: number
	/**
	 * Host filesystem (`ctx.host.fs`) used for on-load file-context validation — the
	 * plugin's `permissions.filesystem: ["."]` grant scopes it. When absent, validation
	 * is skipped and persisted file contexts load unchanged.
	 */
	hostFs?: HostFileSystem
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

function emptyCostTracking(): LiveMemoryCostTracking {
	return {
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalTokensTruncated: 0,
		estimatedCostUSD: 0,
		lastUpdated: Date.now(),
	}
}

function emptyData(workspacePath: string): MemoryData {
	return {
		version: MEMORY_STORE_VERSION,
		workspacePath,
		updatedAt: Date.now(),
		observations: [],
		qa: [],
		stats: { totalObservations: 0, totalQuestions: 0 },
		messages: [],
		fileContexts: [],
		costTracking: emptyCostTracking(),
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
	private readonly hostFs: HostFileSystem | undefined
	private cache: MemoryData | undefined

	constructor(
		private readonly storage: PluginStorage,
		private readonly workspacePath: string,
		opts: MemoryStoreOptions = {},
	) {
		this.fileName = `memory-${hashWorkspace(workspacePath)}.json`
		this.maxObservations = Math.max(1, opts.maxObservations ?? 400)
		this.maxQuestions = Math.max(1, opts.maxQuestions ?? 50)
		this.hostFs = opts.hostFs
	}

	/** The relative file name under the plugin's storage dir (for diagnostics/tests). */
	get relativePath(): string {
		return this.fileName
	}

	/**
	 * Load (once) from storage, tolerating a missing/corrupt file. Backward-tolerant
	 * across store versions: any document from v1 up to the current
	 * {@link MEMORY_STORE_VERSION} is normalized (missing v2 fields default empty);
	 * an unknown/future version starts fresh. On load, persisted file contexts are
	 * validated against the workspace (stale/missing entries evicted) when a host
	 * filesystem was provided.
	 */
	async load(): Promise<MemoryData> {
		if (this.cache) return this.cache
		try {
			if (await this.storage.exists(this.fileName)) {
				const raw = await this.storage.readFile(this.fileName)
				const parsed = JSON.parse(raw) as MemoryData
				if (
					parsed &&
					typeof parsed.version === "number" &&
					parsed.version >= 1 &&
					parsed.version <= MEMORY_STORE_VERSION
				) {
					const data = normalize(parsed, this.workspacePath)
					data.fileContexts = await this.validateFileContexts(data.fileContexts)
					this.cache = data
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

	/**
	 * Replace the persisted conversation slice (messages / file contexts / cost ledger)
	 * and persist. The agent-loop analogue of `ConversationStore.save`, kept alongside
	 * the observation/Q&A log so a later stage can restore a full memory-agent session.
	 */
	async saveConversation(snapshot: ConversationSnapshot): Promise<void> {
		const data = await this.load()
		data.messages = snapshot.messages
		data.fileContexts = snapshot.fileContexts
		data.costTracking = snapshot.costTracking
		await this.persist(data)
	}

	/**
	 * Re-read each file context's source file and keep only the entries whose SHA-256
	 * content hash still matches — the plugin-native port of
	 * `ConversationStore._validateFileContexts`. Missing/unreadable files are evicted.
	 * A no-op (entries returned unchanged) when no host filesystem was provided.
	 */
	private async validateFileContexts(entries: FileContextEntry[]): Promise<FileContextEntry[]> {
		if (!this.hostFs || entries.length === 0) return entries
		const validated: FileContextEntry[] = []
		for (const fc of entries) {
			try {
				const fullPath = resolvePath(this.workspacePath, fc.filePath)
				const content = await this.hostFs.readFile(fullPath)
				const currentHash = createHash("sha256").update(content).digest("hex")
				if (currentHash === fc.contentHash) validated.push(fc)
			} catch {
				// File deleted / unreadable → evict.
			}
		}
		return validated
	}

	/**
	 * **Empty** the workspace memory: delete the persisted document via the plugin's
	 * traversal-blocked storage sandbox (`ctx.storage.delete`) and drop the in-memory
	 * cache so the next {@link load} starts from empty defaults. The plugin-native
	 * analogue of removing the built-in `ConversationStore`'s JSON file. Best-effort on
	 * a missing file (a not-yet-persisted store is already "empty"). Only affects THIS
	 * workspace's file; other workspaces are stored separately and untouched.
	 */
	async empty(): Promise<void> {
		try {
			if (await this.storage.exists(this.fileName)) {
				await this.storage.delete(this.fileName)
			}
		} catch {
			// Missing/unreadable ⇒ already effectively empty (never throws to a hook/UI).
		}
		this.cache = undefined
	}

	private async persist(data: MemoryData): Promise<void> {
		data.updatedAt = Date.now()
		await this.storage.writeFile(this.fileName, JSON.stringify(data, null, "\t"))
	}
}

/** Coerce a loaded document (any supported version) into a well-formed {@link MemoryData}. */
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
		// v2 fields — default empty when loading a v1 document.
		messages: Array.isArray(parsed.messages) ? parsed.messages : base.messages,
		fileContexts: Array.isArray(parsed.fileContexts) ? parsed.fileContexts : base.fileContexts,
		costTracking: parsed.costTracking ? { ...base.costTracking, ...parsed.costTracking } : base.costTracking,
	}
}
