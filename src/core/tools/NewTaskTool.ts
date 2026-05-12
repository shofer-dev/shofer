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

interface NewTaskParams {
	mode: string
	message: string
	todos?: string
	is_background?: boolean | string | number | null
	task_id?: string
}

export class NewTaskTool extends BaseTool<"new_task"> {
	readonly name = "new_task" as const

	async execute(params: NewTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { mode, message, todos } = params
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

			// Parse todos if provided, otherwise use empty array
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
						initialStatus: "active",
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
					console.error(`[NewTaskTool] Failed to update parent history for background child: ${err}`)
				}

				// Track in-memory handle on the parent task instance.
				task.backgroundChildren.set(child.taskId, {
					taskId: child.taskId,
					status: "starting",
					createdAt: Date.now(),
					parentTaskId: task.taskId,
				})

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
						initialStatus: "active",
						initialMode: effectiveMode,
						// openInStack=true (default): child is pushed onto shoferStack on top of parent.
						openInStack: true,
					},
					undefined, // configuration
					undefined,
				)

				// Register resolver after createTask so we have the child's taskId.
				// The child runs asynchronously, so registration completes before any
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

		const partialMessage = JSON.stringify({
			tool: "newTask",
			mode: mode ?? "",
			content: message ?? "",
			todos: todos,
			is_background: is_background,
			task_id: task_id,
		})

		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const newTaskTool = new NewTaskTool()
