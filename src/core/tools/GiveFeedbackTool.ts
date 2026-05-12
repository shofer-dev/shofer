/**
 * GiveFeedbackTool — allows the LLM to send feedback to the Arkware developers.
 *
 * Always-available, harmless meta-operation. The feedback message is appended
 * to the Shofer extension output channel (per project policy: extensions must
 * use the output channel rather than `console.log`) and surfaced in the chat UI
 * via an auto-approved `task.ask("tool", ...)` entry.
 */

import type { ToolUse } from "../../shared/tools"
import { Task } from "../task/Task"
import { getOutputChannel } from "../../extension"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface GiveFeedbackParams {
	feedback: string
}

export class GiveFeedbackTool extends BaseTool<"give_feedback"> {
	readonly name = "give_feedback" as const

	async execute(params: GiveFeedbackParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { feedback } = params
		const { handleError, pushToolResult } = callbacks

		try {
			if (!feedback) {
				task.consecutiveMistakeCount++
				task.recordToolError("give_feedback")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("give_feedback", "feedback"))
				return
			}

			const trimmed = feedback.trim()
			if (!trimmed) {
				task.recordToolError("give_feedback")
				task.didToolFailInCurrentTurn = true
				pushToolResult("Error: Feedback cannot be empty or whitespace only.")
				return
			}

			task.consecutiveMistakeCount = 0

			// Auto-approved via checkAutoApproval, but still shows in chat UI for visibility.
			const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
			const didApprove = await this.askToolApproval(callbacks, {
				tool: "giveFeedback",
				content: `Feedback to Arkware developers:\n${preview}`,
			})
			if (!didApprove) {
				return
			}

			// Persist the full feedback to the extension output channel so users and
			// developers can review it without leaving VS Code. Per project rules,
			// extensions must NOT use console.log.
			const channel = getOutputChannel()
			const stamp = new Date().toISOString()
			const header = `[${stamp}] [FEEDBACK] taskId=${task.taskId}`
			if (channel) {
				channel.appendLine(header)
				channel.appendLine(trimmed)
				channel.appendLine("")
			}

			pushToolResult("Feedback received. Thank you!")
		} catch (error) {
			await handleError("sending feedback", error instanceof Error ? error : new Error(String(error)))
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"give_feedback">): Promise<void> {
		const feedback: string | undefined = block.params.feedback

		const partialMessage = JSON.stringify({
			tool: "giveFeedback",
			content: feedback ?? "",
		})

		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const giveFeedbackTool = new GiveFeedbackTool()
