import NodeCache from "node-cache"
import getFolderSize from "get-folder-size"

import type { ShoferMessage, HistoryItem, TaskState } from "@shofer/types"

import { combineApiRequests } from "../../shared/combineApiRequests"
import { combineCommandSequences } from "../../shared/combineCommandSequences"
import { getApiMetrics } from "../../shared/getApiMetrics"
import { findLastIndex } from "../../shared/array"
import { getTaskDirectoryPath } from "../../utils/storage"
import { t } from "../../i18n"

const taskSizeCache = new NodeCache({ stdTTL: 30, checkperiod: 5 * 60 })

export type TaskMetadataOptions = {
	taskId: string
	rootTaskId?: string
	parentTaskId?: string
	taskNumber: number
	messages: ShoferMessage[]
	globalStoragePath: string
	workspace: string
	/** Per-task working directory (e.g., embedded worktree subdirectory).
	 *  Stored on HistoryItem for correct rehydration. */
	cwd?: string
	mode?: string
	/** Provider profile name for the task (sticky profile feature) */
	apiConfigName?: string
	/** Initial execution state for the task (e.g., for child tasks) */
	initialState?: TaskState
	/** When true, persist `isBackground: true` on the history item. */
	isBackground?: boolean
	/** Per-root-task cost limit (only set on root tasks). */
	costLimit?: import("@shofer/types").CostLimit
	/** Names of skills loaded via skills for this task. */
	loadedSkills?: string[]
	/** Pre-computed token usage, bypassing the O(n) message walk.
	 *  Caller guarantees the value is accurate for the given messages. */
	tokenUsageOverride?: import("@shofer/types").TokenUsage
}

export async function taskMetadata({
	taskId: id,
	rootTaskId,
	parentTaskId,
	taskNumber,
	messages,
	globalStoragePath,
	workspace,
	cwd,
	mode,
	apiConfigName,
	initialState,
	isBackground,
	costLimit,
	loadedSkills,
	tokenUsageOverride,
}: TaskMetadataOptions) {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, id)

	// Determine message availability upfront
	const hasMessages = messages && messages.length > 0

	// Pre-calculate all values based on availability
	let timestamp: number
	let createdAt: number
	let tokenUsage: ReturnType<typeof getApiMetrics>
	let taskDirSize: number
	let taskMessage: ShoferMessage | undefined

	if (!hasMessages) {
		// Handle no messages case
		timestamp = Date.now()
		createdAt = timestamp
		tokenUsage = {
			totalTokensIn: 0,
			totalTokensOut: 0,
			totalCacheWrites: 0,
			totalCacheReads: 0,
			totalCost: 0,
			contextTokens: 0,
		}
		taskDirSize = 0
	} else {
		// Handle messages case
		taskMessage = messages[0] // First message is always the task say.

		// createdAt captures the moment the task was created (first message timestamp).
		createdAt = taskMessage.ts

		const lastRelevantMessage =
			messages[findLastIndex(messages, (m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"))] ||
			taskMessage

		timestamp = lastRelevantMessage.ts

		tokenUsage = tokenUsageOverride ?? getApiMetrics(combineApiRequests(combineCommandSequences(messages.slice(1))))

		// Get task directory size
		const cachedSize = taskSizeCache.get<number>(taskDir)

		if (cachedSize === undefined) {
			try {
				taskDirSize = await getFolderSize.loose(taskDir)
				taskSizeCache.set<number>(taskDir, taskDirSize)
			} catch (error) {
				taskDirSize = 0
			}
		} else {
			taskDirSize = cachedSize
		}
	}

	// Create historyItem once with pre-calculated values.
	// initialStatus is included when provided (e.g., "active" for child tasks)
	// to ensure the status is set from the very first save, avoiding race conditions
	// where attempt_completion might run before a separate status update.
	const historyItem: HistoryItem = {
		id,
		rootTaskId,
		parentTaskId,
		number: taskNumber,
		ts: timestamp,
		createdAt,
		task: hasMessages
			? taskMessage!.text?.trim() || t("common:tasks.incomplete", { taskNumber })
			: t("common:tasks.no_messages", { taskNumber }),
		tokensIn: tokenUsage.totalTokensIn,
		tokensOut: tokenUsage.totalTokensOut,
		cacheWrites: tokenUsage.totalCacheWrites,
		cacheReads: tokenUsage.totalCacheReads,
		totalCost: tokenUsage.totalCost,
		size: taskDirSize,
		workspace,
		mode,
		...(cwd ? { cwd } : {}),
		...(typeof apiConfigName === "string" && apiConfigName.length > 0 ? { apiConfigName } : {}),
		...(initialState ? { taskState: initialState } : {}),
		...(isBackground ? { isBackground: true } : {}),
		...(costLimit ? { costLimit } : {}),
		...(loadedSkills && loadedSkills.length > 0 ? { loadedSkills } : {}),
	}

	return { historyItem, tokenUsage }
}
