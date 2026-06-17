import NodeCache from "node-cache"
import getFolderSize from "get-folder-size"

import type { ShoferMessage, HistoryItem } from "@shofer/types"

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
	/** When true, persist `isBackground: true` on the history item. */
	isBackground?: boolean
	/** Per-root-task cost limit (only set on root tasks). */
	costLimit?: import("@shofer/types").CostLimit
	/** Names of skills loaded via skills for this task. */
	loadedSkills?: string[]
	/** Pre-computed token usage, bypassing the O(n) message walk.
	 *  Caller guarantees the value is accurate for the given messages. */
	tokenUsageOverride?: import("@shofer/types").TokenUsage
	/**
	 * True when `messages` is a tail *window* that does not include the
	 * originating prompt (cold-load of a long task, `hasMoreShoferMessages`).
	 * In that case `messages[0]` is NOT the task root — it's typically an
	 * `api_req_started` whose `.text` is the wire-request blob. Deriving
	 * `task`/`createdAt` from it would clobber the canonical first prompt via
	 * the upsert merge. When set, both fields are omitted so `upsert`
	 * (`{ ...existing, ...item }`) preserves the previously persisted values.
	 */
	windowedMessages?: boolean
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
	isBackground,
	costLimit,
	loadedSkills,
	tokenUsageOverride,
	windowedMessages,
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
	//
	// NOTE: `taskState` is deliberately NOT written here. It is owned
	// exclusively by `TaskManager.setState` (Single-Writer Persistence Rule).
	// Because `TaskHistoryStore.upsert` merges (`{ ...existing, ...item }`),
	// omitting `taskState` preserves whatever TaskManager last persisted —
	// whereas writing a static `initialState` snapshot here would clobber the
	// live lifecycle on every metadata save (e.g. reverting a re-activated
	// task's `running` back to a stale `completed:excellent`).
	// Root-only fields. When `messages` is a tail window (`windowedMessages`),
	// `messages[0]` is not the originating prompt, so deriving these from it
	// would corrupt the canonical first prompt. Omit them entirely (not
	// `undefined`, which would overwrite on merge) so `upsert` preserves the
	// values persisted at task creation.
	const rootMetaFields = windowedMessages
		? {}
		: {
				createdAt,
				task: hasMessages
					? taskMessage!.text?.trim() || t("common:tasks.incomplete", { taskNumber })
					: t("common:tasks.no_messages", { taskNumber }),
			}

	// Asserted (not annotated) because `task` is intentionally omitted when
	// `windowedMessages` is set; the upsert merge supplies the persisted value.
	const historyItem = {
		id,
		rootTaskId,
		parentTaskId,
		number: taskNumber,
		ts: timestamp,
		...rootMetaFields,
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
		...(isBackground ? { isBackground: true } : {}),
		...(costLimit ? { costLimit } : {}),
		...(loadedSkills && loadedSkills.length > 0 ? { loadedSkills } : {}),
	} as HistoryItem

	return { historyItem, tokenUsage }
}
