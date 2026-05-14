import * as fs from "fs/promises"
import * as path from "path"

import type { HistoryItem } from "@shofer/types"

const HISTORY_ITEM_FILENAME = "history_item.json"
const HISTORY_INDEX_FILENAME = "_index.json"

export interface TaskSessionEntry {
	id: string
	task: string
	ts: number
	createdAt?: number
	workspace?: string
	mode?: string
	taskExecutionState?: HistoryItem["taskExecutionState"]
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function extractSessionEntry(value: unknown): TaskSessionEntry | undefined {
	if (!isRecord(value)) {
		return undefined
	}

	const id = value.id
	const task = value.task
	const ts = value.ts
	const createdAt = value.createdAt
	const workspace = value.workspace
	const mode = value.mode
	const taskExecutionState: string | undefined = value.taskExecutionState as string | undefined

	if (typeof id !== "string" || typeof task !== "string" || typeof ts !== "number") {
		return undefined
	}

	return {
		id,
		task,
		ts,
		createdAt: typeof createdAt === "number" ? createdAt : undefined,
		workspace: typeof workspace === "string" ? workspace : undefined,
		mode: typeof mode === "string" ? mode : undefined,
		taskExecutionState:
			taskExecutionState !== undefined &&
			(["idle", "running", "waiting_input", "paused", "error", "completed"] as readonly string[]).includes(
				taskExecutionState,
			)
				? (taskExecutionState as HistoryItem["taskExecutionState"])
				: undefined,
	}
}

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
	try {
		const raw = await fs.readFile(filePath, "utf8")
		return JSON.parse(raw)
	} catch {
		return undefined
	}
}

export async function readTaskSessionsFromStoragePath(storageBasePath: string): Promise<TaskSessionEntry[]> {
	const tasksDir = path.join(storageBasePath, "tasks")
	const sessionsById = new Map<string, TaskSessionEntry>()

	const historyIndex = await readJsonFile(path.join(tasksDir, HISTORY_INDEX_FILENAME))
	const indexEntries = isRecord(historyIndex) && Array.isArray(historyIndex.entries) ? historyIndex.entries : []

	for (const entry of indexEntries) {
		const session = extractSessionEntry(entry)
		if (session) {
			sessionsById.set(session.id, session)
		}
	}

	let taskDirs: string[] = []

	try {
		const entries = await fs.readdir(tasksDir, { withFileTypes: true })
		taskDirs = entries
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."))
			.map((entry) => entry.name)
	} catch {
		// No tasks directory; return index-derived entries only.
	}

	for (const taskId of taskDirs) {
		if (sessionsById.has(taskId)) {
			continue
		}

		const historyItem = await readJsonFile(path.join(tasksDir, taskId, HISTORY_ITEM_FILENAME))
		const session = extractSessionEntry(historyItem)

		if (session) {
			sessionsById.set(session.id, session)
		}
	}

	if (taskDirs.length > 0) {
		const onDiskIds = new Set(taskDirs)
		for (const sessionId of sessionsById.keys()) {
			if (!onDiskIds.has(sessionId)) {
				sessionsById.delete(sessionId)
			}
		}
	}

	return Array.from(sessionsById.values()).sort((a, b) => (b.createdAt ?? b.ts) - (a.createdAt ?? a.ts))
}
