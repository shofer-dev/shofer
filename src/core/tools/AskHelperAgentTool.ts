import * as vscode from "vscode"
import { Task } from "../task/Task"
import { HelperAgentManager } from "../../services/helper-agent/manager"
import { getWorkspacePath } from "../../utils/path"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"
import { BaseTool, ToolCallbacks } from "./BaseTool"

interface AskHelperAgentParams {
	question: string
	contextFiles?: string[]
	timeoutMs?: number
}

export class AskHelperAgentTool extends BaseTool<"ask_helper_agent"> {
	readonly name = "ask_helper_agent" as const

	async execute(params: AskHelperAgentParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { question, contextFiles, timeoutMs } = params

		const workspacePath = task.cwd && task.cwd.trim() !== "" ? task.cwd : getWorkspacePath()

		if (!workspacePath) {
			await handleError("ask_helper_agent", new Error("Could not determine workspace path."))
			return
		}

		if (!question) {
			task.consecutiveMistakeCount++
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("ask_helper_agent", "question"))
			return
		}

		const sharedMessageProps = {
			tool: "askHelperAgent",
			question,
			contextFiles: contextFiles ?? [],
			timeoutMs: timeoutMs ?? 300000,
		}

		const didApprove = await askApproval("tool", JSON.stringify(sharedMessageProps))
		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return
		}

		task.consecutiveMistakeCount = 0

		try {
			const context = task.providerRef.deref()?.context
			if (!context) {
				throw new Error("Extension context is not available.")
			}

			const manager = HelperAgentManager.getInstance(context, workspacePath)

			if (!manager) {
				throw new Error("HelperAgentManager is not available.")
			}

			if (!manager.isHelperAgentAvailable) {
				throw new Error(
					`Helper agent is not available (state: ${manager.state}). ` +
						`Make sure it is enabled and configured in settings.`,
				)
			}

			pushToolResult(`Asking the helper agent: "${question}"...`)

			const result = await manager.askQuestion(question, contextFiles, timeoutMs)

			const output = `Helper Agent Answer:
${result.answer}

---
Context: ${result.contextUsage.currentTokens} / ${result.contextUsage.maxTokens} tokens (${(result.contextUsage.fillFraction * 100).toFixed(1)}% full)
Duration: ${(result.durationMs / 1000).toFixed(1)}s
Tokens: ${result.tokensUsed.prompt} prompt + ${result.tokensUsed.completion} completion = ${result.tokensUsed.total} total
Cost: $${result.costSnapshot.sessionEstimatedCostUSD.toFixed(6)} (session total)
Files in context: ${result.contextFiles.length}`

			pushToolResult(output)
		} catch (error: any) {
			await handleError("ask_helper_agent", error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"ask_helper_agent">): Promise<void> {
		const question: string | undefined = block.params.question

		const sharedMessageProps = {
			tool: "askHelperAgent",
			question: question,
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(() => {})
	}
}

export const askHelperAgentTool = new AskHelperAgentTool()
