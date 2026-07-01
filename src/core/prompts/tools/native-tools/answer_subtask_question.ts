import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "@shofer/core"

const ANSWER_SUBTASK_QUESTION_DESCRIPTION = `Answer a question that a background child task asked via ask_followup_question. When a background child needs clarification, its question is routed to you (the parent) instead of the user. Use this tool to provide the answer and unblock the child.`

const TASK_ID_PARAMETER_DESCRIPTION = `The task ID of the background child that asked the question.`

const ANSWER_PARAMETER_DESCRIPTION = `Your answer to the child's question. Be specific and actionable so the child can continue its work without further clarification.`

export default defineNativeTool({
	name: "answer_subtask_question",
	description: ANSWER_SUBTASK_QUESTION_DESCRIPTION,
	schema: z.object({
		task_id: z.string().describe(TASK_ID_PARAMETER_DESCRIPTION),
		answer: z.string().describe(ANSWER_PARAMETER_DESCRIPTION),
	}),
})
