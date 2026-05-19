import type OpenAI from "openai"

const ANSWER_SUBTASK_QUESTION_DESCRIPTION = `Answer a question that a background child task asked via ask_followup_question. When a background child needs clarification, its question is routed to you (the parent) instead of the user. Use this tool to provide the answer and unblock the child.`

const TASK_ID_PARAMETER_DESCRIPTION = `The task ID of the background child that asked the question.`

const ANSWER_PARAMETER_DESCRIPTION = `Your answer to the child's question. Be specific and actionable so the child can continue its work without further clarification.`

export default {
	type: "function",
	function: {
		name: "answer_subtask_question",
		description: ANSWER_SUBTASK_QUESTION_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				task_id: {
					type: "string",
					description: TASK_ID_PARAMETER_DESCRIPTION,
				},
				answer: {
					type: "string",
					description: ANSWER_PARAMETER_DESCRIPTION,
				},
			},
			required: ["task_id", "answer"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
