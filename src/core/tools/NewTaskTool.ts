import * as vscode from "vscode"

import { TodoItem } from "@roo-code/types"
import { v7 as uuidv7 } from "uuid"

import { Task } from "../task/Task"
import { getModeBySlug } from "../../shared/modes"
import { formatResponse } from "../prompts/responses"
import { parseMarkdownChecklist } from "./UpdateTodoListTool"
import { Package } from "../../shared/package"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"

interface NewTaskParams {
	mode: string
	message: string
	todos?: string
	is_background?: boolean
	task_id?: string
}

export class NewTaskTool extends BaseTool<"new_task"> {
	readonly name = "new_task" as const

	async execute(params: NewTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { mode, message, todos, is_background, task_id } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate required parameters.
			if (!mode) {
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

			// Un-escape one level of backslashes before '@' for hierarchical subtasks
			// Un-escape one level: \\@ -> \@ (removes one backslash for hierarchical subtasks)
			const unescapedMessage = message.replace(/\\\\@/g, "\\@")

			// Verify the mode exists
			const targetMode = getModeBySlug(mode, state?.customModes)

			if (!targetMode) {
				pushToolResult(formatResponse.toolError(`Invalid mode: ${mode}`))
				return
			}

			const toolMessage = JSON.stringify({
				tool: "newTask",
				mode: targetMode.name,
				content: message,
				todos: todoItems,
			})

			const didApprove = await askApproval("tool", toolMessage)

			if (!didApprove) {
				return
			}

			if (is_background) {
				// Async background path: use the existing delegateParentAndOpenChild which already
				// supports background parents (when parent is not the focused task it uses
				// keepCurrentTask=true and registerBackgroundTask). We then skip the delegation
				// metadata so the parent is NOT put into "delegated" state.
				const childTaskId = task_id || uuidv7()

				// delegateParentAndOpenChild creates the child and, when the parent is not focused,
				// automatically calls registerBackgroundTask(child) and keeps the parent active.
				// However it also sets awaitingChildId / status="delegated" on the parent, which
				// we must override afterwards to keep the parent in "active" state.
				const child = await provider.delegateParentAndOpenChild({
					parentTaskId: task.taskId,
					message: unescapedMessage,
					initialTodos: todoItems,
					mode,
				})

				// Override the parent history: remove delegated/awaitingChildId markers and
				// add the child to backgroundChildIds instead so the parent stays active.
				try {
					const { historyItem: parentHistory } = await provider.getTaskWithId(task.taskId)
					const backgroundChildIds = Array.from(
						new Set([...(parentHistory.backgroundChildIds ?? []), child.taskId]),
					)
					await provider.updateTaskHistory({
						...parentHistory,
						status: "active",
						awaitingChildId: undefined,
						backgroundChildIds,
					})
				} catch (err) {
					// Non-fatal: parent history metadata may be stale but child still runs
					console.error(`[NewTaskTool] Failed to update parent history for background child: ${err}`)
				}

				// Track in-memory handle on the parent task instance
				task.backgroundChildren.set(child.taskId, {
					taskId: child.taskId,
					status: "starting",
					createdAt: Date.now(),
					parentTaskId: task.taskId,
				})

				pushToolResult(`Child task started: ${child.taskId}\nStatus: starting`)
				return
			} else {
				// Synchronous delegation: parent enters "delegated" state and waits
				const child = await provider.delegateParentAndOpenChild({
					parentTaskId: task.taskId,
					message: unescapedMessage,
					initialTodos: todoItems,
					mode,
				})

				// Reflect delegation in tool result (no pause/unpause, no wait)
				pushToolResult(`Delegated to child task ${child.taskId}`)
				return
			}
		} catch (error) {
			await handleError("creating new task", error)
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
