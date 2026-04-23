import * as vscode from "vscode"

import { TodoItem } from "@roo-code/types"

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
	todos?: string | null
	is_background?: boolean
	task_id?: string | null
}

export class NewTaskTool extends BaseTool<"new_task"> {
	readonly name = "new_task" as const

	async execute(params: NewTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { mode, message, is_background } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		// Normalise `todos`: the schema permits string|null, but some models emit the
		// literal string "null" (or whitespace) instead of a real null. Treat those as
		// "no todos provided" so we don't feed garbage into parseMarkdownChecklist.
		const rawTodos = params.todos
		const todos: string | undefined =
			typeof rawTodos === "string" && rawTodos.trim() !== "" && rawTodos.trim().toLowerCase() !== "null"
				? rawTodos
				: undefined

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

			// `is_background` is declared required in the JSON schema, but some models
			// still omit it. Reject explicitly so the LLM is forced to pick a mode
			// rather than silently falling through to the synchronous delegation path.
			if (typeof is_background !== "boolean") {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(
						"Missing or invalid 'is_background' parameter: must be a boolean (true for background/async, false for synchronous delegation).",
					),
				)
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
				// position. We must NOT call delegateParentAndOpenChild here because when the
				// parent is the focused task it calls removeClineFromStack(), which sets
				// parent.abort=true and triggers the synchronous delegation resume flow.
				//
				// Instead we call createTask() directly with openInStack=false so the child
				// runs concurrently while the parent continues uninterrupted.
				const child = await provider.createTask(unescapedMessage, undefined, task as any, {
					initialTodos: todoItems,
					initialStatus: "active",
					// startTask is irrelevant here: createTask always calls task.start() internally.
					initialMode: effectiveMode,
					// openInStack=false: child is NOT pushed onto clineStack, so the parent
					// remains the focused task and is never aborted.
					openInStack: false,
					// keepCurrentTask is only checked when parentTask is falsy, so it doesn't
					// matter here, but set it for clarity.
					keepCurrentTask: true,
					// Mark the child as a background task so AttemptCompletionTool will
					// skip the synchronous delegation flow (which would otherwise abort
					// the parent and trigger reopenParentFromDelegation).
					isBackground: true,
				})

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
				// Synchronous delegation: parent enters "delegated" state and waits
				const child = await provider.delegateParentAndOpenChild({
					parentTaskId: task.taskId,
					message: unescapedMessage,
					initialTodos: todoItems,
					mode: effectiveMode,
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
