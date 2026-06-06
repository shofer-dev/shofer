import * as vscode from "vscode"

import { TodoItem } from "@shofer/types"

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
}

/** Hard safety cap for subtask completion result length, in characters. */
export const MAX_SUBTASK_RESULT_LENGTH = 100000

/** Default soft result length (characters) when LLM does not provide one. */
const DEFAULT_SOFT_RESULT_LENGTH = 2000

/** Default soft timeout (seconds) when LLM does not provide one. */
const DEFAULT_SOFT_TIMEOUT_SEC = 300

export class NewTaskTool extends BaseTool<"new_task"> {
	readonly name = "new_task" as const

	async execute(params: NewTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { mode, message, todos, softResultLength, softTimeoutSec } = params
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
			})

			const didApprove = await askApproval("tool", toolMessage)

			if (!didApprove) {
				return
			}

			if (is_background) {
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
					},
					undefined, // configuration
					undefined,
				)

				// Register the child with TaskManager so it is tracked as a managed background task.
				provider.taskManager.registerBackgroundTask(child)

				// Persist the parent-child relationship in parent's history WITHOUT changing
				// status or setting awaitingChildId (parent must remain "active").
				try {
					const { historyItem: parentHistory } = await provider.getTaskWithId(task.taskId)
					const backgroundChildIds = Array.from(
						new Set([...(parentHistory.backgroundChildIds ?? []), child.taskId]),
					)
					const childIds = Array.from(new Set([...(parentHistory.childIds ?? []), child.taskId]))
					await provider.updateTaskHistory({
						...parentHistory,
						// Deliberately NOT changing status or setting awaitingChildId.
						backgroundChildIds,
						childIds,
					})
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

				// Dynamic-add: add the spawned child's taskId to the spawner's
				// knownPeers so the spawner can message it (least-privilege
				// baseline — the spawner can reach parent + own children).
				// When knownPeers is undefined (root user task with no peer grants),
				// skip — the spawner does not participate in peer messaging.
				if (task.knownPeers) {
					task.knownPeers.add(child.taskId)
				}

				// Baseline knownPeers for the child: parent only (least-privilege default).
				const childPeers = new Set<string>([task.taskId])

				// Extend with peer_task_ids if explicitly granted.
				if (params.peer_task_ids && params.peer_task_ids.length > 0) {
					for (const peerId of params.peer_task_ids) {
						// Validate all peer_task_ids share the spawner's rootTaskId.
						const peerLive = provider.taskManager.getManagedTaskInstance(peerId)
						if (peerLive && peerLive.rootTaskId !== task.rootTaskId) {
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
				child.knownPeers = childPeers

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
					},
					undefined, // configuration
					undefined,
				)

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
		})

		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const newTaskTool = new NewTaskTool()
