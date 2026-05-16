import * as vscode from "vscode"
import { Task } from "../task/Task"
import { HelperAgentManager } from "../../services/helper-agent/manager"
import { getWorkspacePath } from "../../utils/path"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { logger } from "../../utils/logging"

const LOG_PREFIX = "[AskHelperAgentTool]"

interface AskHelperAgentParams {
	question: string
	contextFiles?: string[] | null
	timeoutMs?: number | null
	softTimeoutMs?: number | null
	softResultLength?: number | null
}

export class AskHelperAgentTool extends BaseTool<"ask_helper_agent"> {
	readonly name = "ask_helper_agent" as const

	async execute(params: AskHelperAgentParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { question } = params
		// `?? undefined` collapses the nullable strict-mode placeholders the
		// model passes for "no value" so the downstream defaults apply.
		const contextFiles = params.contextFiles ?? undefined
		const timeoutMs = params.timeoutMs ?? undefined
		const softTimeoutMs = params.softTimeoutMs ?? undefined
		const softResultLength = params.softResultLength ?? undefined

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

		logger.info(
			`${LOG_PREFIX} execute() invoked taskId=${task.taskId} questionLen=${question.length} contextFiles=${(contextFiles ?? []).length} timeoutMs=${timeoutMs ?? "default"}`,
		)

		const didApprove = await askApproval("tool", JSON.stringify(sharedMessageProps))
		if (!didApprove) {
			logger.info(`${LOG_PREFIX} approval denied taskId=${task.taskId}`)
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

			logger.info(
				`${LOG_PREFIX} manager state=${manager.state} available=${manager.isHelperAgentAvailable} stateMessage=${JSON.stringify(manager.stateMessage)}`,
			)

			if (!manager.isHelperAgentAvailable) {
				throw new Error(
					`Helper agent is not available (state: ${manager.state}). ` +
						`Make sure it is enabled and configured in settings.`,
				)
			}

			logger.info(
				`${LOG_PREFIX} -> manager.askQuestion taskId=${task.taskId} softTimeoutMs=${softTimeoutMs ?? "default"} softResultLength=${softResultLength ?? "default"}`,
			)
			const startedAt = Date.now()
			const result = await manager.askQuestion(question, contextFiles, {
				timeoutMs,
				softTimeoutMs,
				softResultLength,
			})
			logger.info(
				`${LOG_PREFIX} <- manager.askQuestion taskId=${task.taskId} durationMs=${Date.now() - startedAt} answerLen=${result.answer.length} prompt=${result.tokensUsed.prompt} completion=${result.tokensUsed.completion}`,
			)

			// Render the helper agent's answer in chat as a follow-up `tool` say
			// so the user can read (and expand) the response inline. Without this
			// the chat would only show "Shofer wants to use Ask Helper Agent" and
			// the answer would be silently appended to the model's tool_result.
			const sayPayload = {
				tool: "askHelperAgent",
				question,
				answer: result.answer,
				contextFiles: result.contextFiles ?? [],
				timeoutMs: timeoutMs ?? 300000,
				durationMs: result.durationMs,
				tokensTotal: result.tokensUsed.total,
				costUSD: result.costSnapshot.sessionEstimatedCostUSD,
			}
			await task.say("tool", JSON.stringify(sayPayload))

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
			logger.error(
				`${LOG_PREFIX} execute() FAILED taskId=${task.taskId} error=${error?.message ?? String(error)}\n${error?.stack ?? "(no stack)"}`,
			)
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
