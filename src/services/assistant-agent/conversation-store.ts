/**
 * ConversationStore — persistence layer for the Assistant Agent.
 *
 * Owns the on-disk representation of a single workspace's conversation:
 * messages, file context entries, cost ledger. Stateless beyond its
 * configured paths; safe to construct multiple times.
 *
 * Lives on disk under <globalStorage>/shofer-assistant-agent-<workspaceHash>.json.
 * The workspace hash is sha256(workspacePath)[:16] so multiple workspaces
 * coexist without conflict and the path stays bounded.
 *
 * On load, file contexts are validated against current workspace state:
 *  - missing files are evicted silently
 *  - hash mismatches are evicted silently (stale references)
 * This keeps the persisted file_context coherent with the workspace.
 */

import * as fs from "fs/promises"
import * as path from "path"
import { createHash } from "crypto"

import {
	CONVERSATION_STORE_VERSION,
	type AgentMessage,
	type FileContextEntry,
	type AssistantAgentConversationData,
	type AssistantAgentCostTracking,
} from "@shofer/types"

import { logger } from "../../utils/logging"

/** Persisted snapshot returned by load() / accepted by save(). */
export interface ConversationSnapshot {
	messages: AgentMessage[]
	fileContexts: FileContextEntry[]
	costTracking: AssistantAgentCostTracking
}

/** Empty snapshot used when no prior conversation exists. */
export function emptyConversation(): ConversationSnapshot {
	return {
		messages: [],
		fileContexts: [],
		costTracking: {
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalTokensTruncated: 0,
			estimatedCostUSD: 0,
			lastUpdated: Date.now(),
		},
	}
}

export class ConversationStore {
	private readonly _filePath: string

	constructor(
		private readonly workspacePath: string,
		globalStorageFsPath: string,
	) {
		const workspaceHash = createHash("sha256").update(workspacePath).digest("hex").substring(0, 16)
		this._filePath = path.join(globalStorageFsPath, `shofer-assistant-agent-${workspaceHash}.json`)
	}

	/** Absolute path of the on-disk file (visible for diagnostics/tests). */
	public get filePath(): string {
		return this._filePath
	}

	/**
	 * Load the conversation from disk. Returns an empty snapshot if none
	 * exists yet, or if the version is incompatible. File contexts are
	 * validated against workspace state and stale entries are dropped.
	 */
	public async load(): Promise<ConversationSnapshot> {
		let parsed: AssistantAgentConversationData
		try {
			const data = await fs.readFile(this._filePath, "utf-8")
			parsed = JSON.parse(data) as AssistantAgentConversationData
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				logger.error(
					`[AssistantAgent.ConversationStore] Error reading ${this._filePath}: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			return emptyConversation()
		}

		if (parsed.version !== CONVERSATION_STORE_VERSION) {
			logger.warn(`[AssistantAgent.ConversationStore] Unknown version ${parsed.version}; starting fresh`)
			return emptyConversation()
		}

		const validatedFileContexts = await this._validateFileContexts(parsed.fileContexts ?? [])

		return {
			messages: parsed.messages ?? [],
			fileContexts: validatedFileContexts,
			costTracking: parsed.costTracking ?? emptyConversation().costTracking,
		}
	}

	/** Persist the snapshot. Creates the parent directory if needed. */
	public async save(snapshot: ConversationSnapshot): Promise<void> {
		const dir = path.dirname(this._filePath)
		await fs.mkdir(dir, { recursive: true })

		const data: AssistantAgentConversationData = {
			version: CONVERSATION_STORE_VERSION as 1,
			workspacePath: this.workspacePath,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			messages: snapshot.messages,
			fileContexts: snapshot.fileContexts,
			costTracking: snapshot.costTracking,
		}

		await fs.writeFile(this._filePath, JSON.stringify(data, null, "\t"), "utf-8")
	}

	/**
	 * Re-read each file context's source file and keep only the entries
	 * whose content hash still matches.
	 */
	private async _validateFileContexts(entries: FileContextEntry[]): Promise<FileContextEntry[]> {
		const validated: FileContextEntry[] = []
		for (const fc of entries) {
			try {
				const fullPath = path.resolve(this.workspacePath, fc.filePath)
				const content = await fs.readFile(fullPath, "utf-8")
				const currentHash = createHash("sha256").update(content).digest("hex")
				if (currentHash === fc.contentHash) {
					validated.push(fc)
				}
			} catch {
				// File deleted / unreadable → evict
			}
		}
		return validated
	}
}
