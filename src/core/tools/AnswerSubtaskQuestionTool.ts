import { BaseTool, ToolCallbacks } from "./BaseTool"
import { getManagedTaskTitle } from "./helpers/managedTaskTitle"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"

interface AnswerSubtaskQuestionParams {
	task_id: string
	answer: string
}

export class AnswerSubtaskQuestionTool extends BaseTool<"answer_subtask_question"> {
	readonly name = "answer_subtask_question" as const

	async execute(params: AnswerSubtaskQuestionParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { task_id, answer } = params
		const { askApproval, pushToolResult } = callbacks

		const handle = task.backgroundChildren.get(task_id)
		if (!handle) {
			pushToolResult(formatResponse.toolError(`Task ${task_id} not found in background children`))
			return
		}

		// Check if this child actually has a pending question.
		const provider = task.providerRef.deref()
		if (!provider) {
			pushToolResult(formatResponse.toolError("Provider reference lost"))
			return
		}

		const liveInstance = provider.taskManager.getManagedTaskInstance(task_id)
		if (!liveInstance) {
			pushToolResult(formatResponse.toolError(`Task ${task_id} is no longer alive`))
			return
		}

		// Check if the child is waiting for parent input.
		const pendingQuestion = (liveInstance as any)._pendingParentQuestion
		if (!pendingQuestion) {
			pushToolResult(formatResponse.toolError(`Task ${task_id} does not have a pending question`))
			return
		}

		// Finalize the streaming partial "tool" ask. Auto-approved.
		const completeMessage = JSON.stringify({
			tool: "answerSubtaskQuestion",
			task_id,
			task_title: getManagedTaskTitle(task, task_id),
			answer,
		})
		const didApprove = await askApproval("tool", completeMessage)
		if (!didApprove) {
			return
		}

		// Resolve the child's pending question with the parent's answer.
		pendingQuestion.resolve(answer)
		delete (liveInstance as any)._pendingParentQuestion

		pushToolResult(`Answered question for task ${task_id}`)
	}

	override async handlePartial(task: Task, block: ToolUse<"answer_subtask_question">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "answerSubtaskQuestion",
			task_id: block.params.task_id ?? "",
		})
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const answerSubtaskQuestionTool = new AnswerSubtaskQuestionTool()
