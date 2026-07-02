import { z } from "zod"

import { ShoferMessage } from "./message.js"

/**
 * TodoStatus
 */
export const todoStatusSchema = z.enum(["pending", "in_progress", "completed"] as const)

export type TodoStatus = z.infer<typeof todoStatusSchema>

/**
 * TodoItem
 */
export const todoItemSchema = z.object({
	id: z.string(),
	content: z.string(),
	status: todoStatusSchema,
})

export type TodoItem = z.infer<typeof todoItemSchema>

/**
 * Extracts the most recent todo list from a stream of Shofer messages.
 */
export function getLatestTodo(shoferMessages: ShoferMessage[]) {
	const todos = shoferMessages
		.filter(
			(msg) =>
				(msg.type === "ask" && msg.ask === "tool") || (msg.type === "say" && msg.say === "user_edit_todos"),
		)
		.map((msg) => {
			try {
				return JSON.parse(msg.text ?? "{}")
			} catch {
				return null
			}
		})
		.filter((item) => item && item.tool === "updateTodoList" && Array.isArray(item.todos))
		.map((item) => item.todos)
		.pop()

	if (todos) {
		return todos
	} else {
		return []
	}
}
