import * as vscode from "vscode"

import { TodoItem } from "@shofer/types"
import type { HistoryItem } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

import { Task } from "../task/Task"
import { aggregateTaskCostsRecursive } from "../webview/aggregateTaskCosts"
import { getModeBySlug } from "../../shared/modes"
import { formatResponse } from "../prompts/responses"
import { parseMarkdownChecklist } from "./UpdateTodoListTool"
import { Package } from "../../shared/package"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { parseToolBoolean } from "./helpers/toolInputParsing"
import type { ToolUse } from "../../shared/tools"
import { taskLog } from "../../utils/logging/subsystems"

interface NewTaskParams {
	mode: string
	message: string
	todos?: string
	is_background?: boolean | string | number | null
	task_id?: string
	softResultLength?: number
	softTimeoutSec?: number
	peer_task_ids?: string[] | null
	title?: string
}

/** Hard safety cap for subtask completion result length, in characters. */
export const MAX_SUBTASK_RESULT_LENGTH = 100000

/** Default soft result length (characters) when LLM does not provide one. */
const DEFAULT_SOFT_RESULT_LENGTH = 2000

/** Default soft timeout (seconds) when LLM does not provide one. */
const DEFAULT_SOFT_TIMEOUT_SEC = 300

/** Collapse whitespace and clip to `max` chars for a Sequence-view arrow label. */
const vizTruncate = (value: string | undefined, max = 80): string => {
	const s = (value ?? "").replace(/\s+/g, " ").trim()
	return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export class NewTaskTool extends BaseTool<"new_task"> {
	readonly name = "new_task" as const

	async execute(params: NewTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { mode, message, todos, softResultLength, softTimeoutSec } = params
		// Optional caller-provided title. When supplied, it becomes the child's
		// display name AND locks it — the child cannot override it via
		// set_task_title. Trim/clamp to 60 chars to match SetTaskTitleTool's bound;
		// a whitespace-only value is treated as absent (no title, no lock).
		const effectiveTitle = params.title?.trim().substring(0, 60) || undefined
		// Normalize is_background across the various representations LLMs emit
		// ("true"/"false", 0/1, native boolean, etc.). Absent/unrecognized → false.
		const is_background = parseToolBoolean(params.is_background) ?? false
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate required parameters.
			// If mode is not specified, fall back to the parent task's current mode.
			const effectiveMode = mode || (await task.getTaskMode())
			if (!effectiveMode) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "mode"))
				return
			}

			if (!message) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "message"))
				return
			}

			// softResultLength: optional advisory parameter. Apply default and clamp
			// to hard cap when the LLM doesn't provide a value (or provides an invalid one).
			const effectiveSoftResultLength =
				softResultLength !== undefined &&
				softResultLength !== null &&
				Number.isFinite(softResultLength) &&
				softResultLength > 0 &&
				Number.isInteger(softResultLength)
					? softResultLength
					: DEFAULT_SOFT_RESULT_LENGTH
			const clampedResultLength = Math.min(effectiveSoftResultLength, MAX_SUBTASK_RESULT_LENGTH)

			// softTimeoutSec: optional advisory parameter. Apply default when missing.
			const effectiveSoftTimeoutSec =
				softTimeoutSec !== undefined &&
				softTimeoutSec !== null &&
				Number.isFinite(softTimeoutSec) &&
				softTimeoutSec > 0
					? softTimeoutSec
					: DEFAULT_SOFT_TIMEOUT_SEC

			// Get the VSCode setting for requiring todos.
			const provider = task.providerRef.deref()

			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			const state = await provider.getState()

			// Use Package.name (dynamic at build time) as the VSCode configuration namespace.
			// Supports multiple extension variants (e.g., stable/nightly) without hardcoded strings.
			const requireTodos = vscode.workspace
				.getConfiguration(Package.name)
				.get<boolean>("newTaskRequireTodos", false)

			// Check if todos are required based on VSCode setting.
			// Note: `undefined` means not provided, empty string is valid.
			if (requireTodos && todos === undefined) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "todos"))
				return
			}

			// Parse todos for validation and display in the ChatRow approval
			// block. The child task starts with these todos as its initial
			// checklist — each child manages its own work tracking independently.
			let todoItems: TodoItem[] = []
			if (todos) {
				try {
					todoItems = parseMarkdownChecklist(todos)
				} catch (error) {
					task.consecutiveMistakeCount++
					task.recordToolError("new_task")
					task.didToolFailInCurrentTurn = true
					pushToolResult(formatResponse.toolError("Invalid todos format: must be a markdown checklist"))
					return
				}
			}

			task.consecutiveMistakeCount = 0

			// Enforce the global parallel-task limit.
			const maxParallel = provider.contextProxy.getValue("maxParallelTasks")
			const effectiveLimit = maxParallel ?? 10 // default when unset
			if (effectiveLimit > 0) {
				const activeCount = provider.taskManager.countActiveTasks()
				if (activeCount >= effectiveLimit) {
					pushToolResult(
						formatResponse.toolError(
							`Task limit reached: ${activeCount}/${effectiveLimit} tasks are currently running. ` +
								`Please wait for one to complete and try again later, ` +
								`or accomplish this work through other means (e.g., inline tool calls).`,
						),
					)
					return
				}
			}

			// Refuse to spawn a subtask that would push the root over its cost cap.
			// Walks up to the true root, then aggregates costs across the whole subtree.
			let rootCursor: Task = task
			while (rootCursor.parentTask) {
				rootCursor = rootCursor.parentTask
			}
			const costLimit = rootCursor.costLimit
			if (costLimit && costLimit.maxUsd > 0) {
				try {
					const aggregated = await aggregateTaskCostsRecursive(rootCursor.taskId, (id) =>
						provider.getTaskWithId(id).then((r) => r.historyItem),
					)
					if (aggregated.totalCost >= costLimit.maxUsd) {
						pushToolResult(
							formatResponse.toolError(
								`Cost limit reached: $${aggregated.totalCost.toFixed(2)} of $${costLimit.maxUsd.toFixed(2)}. Cannot spawn new task.`,
							),
						)
						return
					}
				} catch (err) {
					// Non-fatal: if cost aggregation fails, prefer not to block the user.
					provider.log(
						`[NewTaskTool] cost-limit check failed for root ${rootCursor.taskId}: ${err instanceof Error ? err.message : String(err)}`,
					)
				}
			}

			// Un-escape one level of backslashes before '@' for hierarchical subtasks
			// Un-escape one level: \\@ -> \@ (removes one backslash for hierarchical subtasks)
			const unescapedMessage = message.replace(/\\\\@/g, "\\@")

			// Verify the mode exists
			const targetMode = getModeBySlug(effectiveMode, state?.customModes)

			if (!targetMode) {
				pushToolResult(formatResponse.toolError(`Invalid mode: ${effectiveMode}`))
				return
			}

			const toolMessage = JSON.stringify({
				tool: "newTask",
				mode: targetMode.name,
				content: message,
				todos: todoItems,
				is_background: is_background ?? false,
				softResultLength: effectiveSoftResultLength,
				softTimeoutSec: effectiveSoftTimeoutSec,
				...(params.peer_task_ids && params.peer_task_ids.length > 0
					? { peer_task_ids: params.peer_task_ids }
					: {}),
				...(effectiveTitle ? { title: effectiveTitle } : {}),
			})

			const didApprove = await askApproval("tool", toolMessage)

			if (!didApprove) {
				return
			}

			// Telemetry: a subtask is about to be spawned. taskId is the parent.
			if (TelemetryService.hasInstance()) {
				TelemetryService.instance.captureSubtaskSpawned(task.taskId, effectiveMode, is_background)
			}

			if (is_background) {
				// Compute the child's peer grants BEFORE creating it, so they can be
				// seeded at construction via initialKnownPeers. The child then persists
				// its own HistoryItem.peerIds from its first save (see
				// _refreshTaskMetadata) — there is no racy post-creation write by the
				// spawner (the old "Task not found" path), and the grant — including the
				// parent edge — survives restarts.
				//
				// Baseline: parent only (least-privilege). Extended with peer_task_ids
				// when explicitly granted, validated to share the spawner's rootTaskId.
				// Validating before createTask also avoids spawning an orphan child that
				// we then reject.
				const childPeers = new Set<string>([task.taskId])
				if (params.peer_task_ids && params.peer_task_ids.length > 0) {
					// When the spawner is the root (no rootTaskId), use its own taskId;
					// children inherit rootTaskId from the root.
					const spawnerRoot = task.rootTaskId ?? task.taskId
					for (const peerId of params.peer_task_ids) {
						const peerLive = provider.taskManager.getManagedTaskInstance(peerId)
						if (peerLive && peerLive.rootTaskId !== spawnerRoot) {
							pushToolResult(
								formatResponse.toolError(
									`peer_task_ids validation: task ${peerId} does not share your root task.`,
								),
							)
							return
						}
						childPeers.add(peerId)
					}
				}

				// Async background path: create the child WITHOUT touching the parent's stack
				// position. We call createTask() with openInStack=false so the child runs
				// concurrently while the parent continues uninterrupted.
				const child = await provider.createTask(
					unescapedMessage,
					undefined,
					task as any,
					{
						initialTodos: todoItems,
						initialState: { lifecycle: "running" },
						// startTask is irrelevant here: createTask always calls task.start() internally.
						initialMode: effectiveMode,
						// openInStack=false: child is NOT pushed onto shoferStack, so the parent
						// remains the focused task and is never aborted.
						openInStack: false,
						// keepCurrentTask is only checked when parentTask is falsy, so it doesn't
						// matter here, but set it for clarity.
						keepCurrentTask: true,
						// Mark the child as a background task so AttemptCompletionTool takes
						// the background-completion path rather than the foreground-resume path.
						isBackground: true,
						// Pass result length and estimated timeout to the child task.
						softResultLength: clampedResultLength,
						softTimeoutSec: effectiveSoftTimeoutSec,
						// Seed the child's peer grants at construction so its FIRST persisted
						// HistoryItem.peerIds already carries them — no post-creation race.
						initialKnownPeers: Array.from(childPeers),
						// Caller-locked title (if provided): seeds HistoryItem.name +
						// nameLocked from the first save; the child cannot override it.
						initialTitle: effectiveTitle,
					},
					undefined, // configuration
					undefined,
				)

				// Record the spawned child id on the parent so the task-viz spawn
				// interaction (and ToolSpan.spawnedTaskId) point at the real child.
				task.childTaskId = child.taskId

				// Register the child with TaskManager so it is tracked as a managed background task.
				provider.taskManager.registerBackgroundTask(child)

				// Grant the parent (root↔child) messaging to this child. The child side
				// was seeded via initialKnownPeers above; this is the parent's own grant,
				// persisted in the history write below so parent→child survives restarts.
				if (!task.knownPeers) {
					task.knownPeers = new Set<string>()
				}
				task.knownPeers.add(child.taskId)

				// Persist the parent-child relationship AND the parent's peer grant WITHOUT
				// changing status or setting awaitingChildId (parent must remain "active").
				// Write a minimal delta keyed by id: updateTaskHistory → upsert merges over
				// the live cached item, so we don't clobber fields the parent updated
				// concurrently (the lost-update hazard of spreading a stale full snapshot).
				try {
					const { historyItem: parentHistory } = await provider.getTaskWithId(task.taskId)
					const backgroundChildIds = Array.from(
						new Set([...(parentHistory.backgroundChildIds ?? []), child.taskId]),
					)
					const childIds = Array.from(new Set([...(parentHistory.childIds ?? []), child.taskId]))
					await provider.updateTaskHistory({
						id: task.taskId,
						backgroundChildIds,
						childIds,
						peerIds: Array.from(task.knownPeers),
					} as HistoryItem)
				} catch (err) {
					// Non-fatal: parent history metadata may be stale but child still runs.
					taskLog.error(`[NewTaskTool] Failed to update parent history for background child: ${err}`)
				}

				// Track in-memory handle on the parent task instance.
				task.backgroundChildren.set(child.taskId, {
					taskId: child.taskId,
					status: "starting",
					createdAt: Date.now(),
					parentTaskId: task.taskId,
				})

				// ── Symmetric peering ───────────────────────────────────────────
				// A granted peer edge is bidirectional: the child can already reach
				// each granted peer (seeded into the child's knownPeers above), so
				// mirror the reverse edge — add the child to each granted peer's
				// knownPeers — so the peer can reach the child too. Spawn-time grants
				// can only name tasks that already exist, so a grant is necessarily
				// expressed one-directionally; without this mirror, child→peer works
				// but peer→child is blocked, which breaks any back-and-forth
				// conversation.
				//
				// Note: symmetry only mirrors edges the spawner EXPLICITLY granted via
				// peer_task_ids. It does NOT transitively connect siblings that merely
				// share a parent — to make two siblings talk, spawn the later one with
				// peer_task_ids=[earlierSibling]; this mirror makes that single grant
				// two-way. The reverse edge targets the peer's record, which already
				// exists (the peer predates the child), so — unlike a write to the
				// just-spawned child's own row — it persists cleanly.
				if (params.peer_task_ids && params.peer_task_ids.length > 0) {
					for (const peerId of params.peer_task_ids) {
						// Live, in-memory mirror — immediate and race-free this session.
						const peerLive = provider.taskManager.getManagedTaskInstance(peerId)
						if (peerLive) {
							if (!peerLive.knownPeers) {
								peerLive.knownPeers = new Set<string>()
							}
							peerLive.knownPeers.add(child.taskId)
						}
						// Persist the reverse edge onto the peer's history row so it
						// survives restarts (rehydrated via historyItem.peerIds in the
						// Task constructor).
						try {
							const { historyItem: peerHistory } = await provider.getTaskWithId(peerId)
							const peerIds = Array.from(new Set([...(peerHistory.peerIds ?? []), child.taskId]))
							await provider.updateTaskHistory({
								id: peerId,
								peerIds,
							} as HistoryItem)
						} catch (err) {
							// Non-fatal: the live mirror (if any) still works this
							// session; only restart-survival of the reverse edge is lost.
							taskLog.error(
								`[NewTaskTool] Failed to persist symmetric peer edge ${peerId}→${child.taskId}: ${err}`,
							)
						}
					}
				}

				pushToolResult(`Child task started: ${child.taskId}\nStatus: starting`)
				return
			} else {
				// Foreground (blocking) path: parent suspends via Promise until child completes.
				// The parent Task instance stays alive in the shoferStack below the child;
				// this tool handler awaits the Promise, keeping the parent's tool loop alive.
				let resolveChildCompletion!: (result: string) => void
				const childCompletionPromise = new Promise<string>((resolve) => {
					resolveChildCompletion = resolve
				})

				const child = await provider.createTask(
					unescapedMessage,
					undefined,
					task as any,
					{
						initialTodos: todoItems,
						initialState: { lifecycle: "running" },
						initialMode: effectiveMode,
						// openInStack=true (default): child is pushed onto shoferStack on top of parent.
						openInStack: true,
						// Pass result length and estimated timeout to the child task.
						softResultLength: clampedResultLength,
						softTimeoutSec: effectiveSoftTimeoutSec,
						// Caller-locked title (if provided): seeds HistoryItem.name +
						// nameLocked from the first save; the child cannot override it.
						initialTitle: effectiveTitle,
					},
					undefined, // configuration
					undefined,
				)

				// Record the spawned child id on the parent (task-viz spawn arrow).
				task.childTaskId = child.taskId

				// Task Visualization — record the spawn arrow (parent → child) here,
				// not via the post-dispatch recorder in presentAssistantMessage. This is
				// a blocking foreground spawn: the post-dispatch hook only fires after
				// the long `await childCompletionPromise` below, and was observed to drop
				// the arrow for completed blocking calls. The matching return arrow is
				// recorded once the child completes. Both render solid (sync).
				await task.emitTaskInteraction({
					fromTaskId: task.taskId,
					toTaskId: child.taskId,
					kind: "spawn",
					label: vizTruncate(effectiveMode ?? unescapedMessage),
					async: false,
				})

				// Register resolver after createTask so we have the child's taskId.
				// The child runs asynchronously, so registration completes before any
				// Peer sync collision check before registration: a task
				// cannot simultaneously be a blocking child AND a peer sync target.
				if (provider.hasPendingSyncResolver?.(child.taskId)) {
					pushToolResult(
						formatResponse.toolError(
							`Task ${child.taskId} is already serving a sync request and cannot accept another until it completes.`,
						),
					)
					return
				}

				// attempt_completion could fire.
				provider.registerBlockingChildResolver(child.taskId, resolveChildCompletion)

				// Suspend this tool handler until the child completes.
				const completionResult = await childCompletionPromise

				// Task Visualization — record the return arrow (child → parent) now that
				// the blocking child has completed. Solid (sync) answer arrow.
				await task.emitTaskInteraction({
					fromTaskId: child.taskId,
					toTaskId: task.taskId,
					kind: "answer",
					label: vizTruncate(completionResult),
					async: false,
				})

				pushToolResult(`Subtask ${child.taskId} completed\n${completionResult}`)
				return
			}
		} catch (error) {
			await handleError("creating new task", error instanceof Error ? error : new Error(String(error)))
			return
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"new_task">): Promise<void> {
		const mode: string | undefined = block.params.mode
		const message: string | undefined = block.params.message
		const todos: string | undefined = block.params.todos
		const is_background: boolean | undefined =
			block.params.is_background === "true" ? true : block.params.is_background === "false" ? false : undefined
		const task_id: string | undefined = block.params.task_id
		const softResultLength: number | undefined =
			block.params.softResultLength !== undefined ? Number(block.params.softResultLength) : undefined
		const softTimeoutSec: number | undefined =
			block.params.softTimeoutSec !== undefined ? Number(block.params.softTimeoutSec) : undefined
		const peer_task_ids: string | undefined = block.params.peer_task_ids
		const title: string | undefined = block.params.title

		const partialMessage = JSON.stringify({
			tool: "newTask",
			mode: mode ?? "",
			content: message ?? "",
			todos: todos,
			is_background: is_background,
			task_id: task_id,
			softResultLength: softResultLength,
			softTimeoutSec: softTimeoutSec,
			peer_task_ids: peer_task_ids,
			title: title,
		})

		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const newTaskTool = new NewTaskTool()
