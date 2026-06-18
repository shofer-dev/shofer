import * as vscode from "vscode"
import { Task } from "../task/Task"
import { LiveMemoryManager } from "../../services/live-memory/manager"
import { getWorkspacePath } from "../../utils/path"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { liveMemoryLog as logger } from "../../utils/logging/subsystems"

const LOG_PREFIX = "[AskLiveMemoryTool]"

interface AskLiveMemoryParams {
	question: string
	contextFiles?: string[] | null
	timeoutMs?: number | null
	softTimeoutSec?: number | null
	softResultLength?: number | null
}

export class AskLiveMemoryTool extends BaseTool<"ask_live_memory"> {
	readonly name = "ask_live_memory" as const

	async execute(params: AskLiveMemoryParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { question } = params
		// `?? undefined` collapses the nullable strict-mode placeholders the
		// model passes for "no value" so the downstream defaults apply.
		const contextFiles = params.contextFiles ?? undefined
		const timeoutMs = params.timeoutMs ?? undefined
		const softTimeoutSec = params.softTimeoutSec ?? undefined
		const softResultLength = params.softResultLength ?? undefined

		const workspacePath = task.cwd && task.cwd.trim() !== "" ? task.cwd : getWorkspacePath()

		if (!workspacePath) {
			await handleError("ask_live_memory", new Error("Could not determine workspace path."))
			return
		}

		if (!question) {
			task.consecutiveMistakeCount++
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError("ask_live_memory", "question"))
			return
		}

		const sharedMessageProps = {
			tool: "askLiveMemory",
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

			const manager = LiveMemoryManager.getInstance(context, workspacePath)

			if (!manager) {
				throw new Error("LiveMemoryManager is not available.")
			}

			logger.info(
				`${LOG_PREFIX} manager state=${manager.state} available=${manager.isLiveMemoryAvailable} stateMessage=${JSON.stringify(manager.stateMessage)}`,
			)

			if (!manager.isLiveMemoryAvailable) {
				throw new Error(
					`Live memory is not available (state: ${manager.state}). ` +
						`Make sure it is enabled and configured in settings.`,
				)
			}

			logger.info(
				`${LOG_PREFIX} -> manager.askQuestion taskId=${task.taskId} softTimeoutSec=${softTimeoutSec ?? "default"} softResultLength=${softResultLength ?? "default"}`,
			)
			const startedAt = Date.now()
			const result = await manager.askQuestion(question, contextFiles, {
				timeoutMs,
				softTimeoutSec,
				softResultLength,
			})
			logger.info(
				`${LOG_PREFIX} <- manager.askQuestion taskId=${task.taskId} durationMs=${Date.now() - startedAt} answerLen=${result.answer.length} prompt=${result.tokensUsed.prompt} completion=${result.tokensUsed.completion}`,
			)

			// Render the live memory answer in chat as a follow-up `tool` say
			// so the user can read (and expand) the response inline. Without this
			// the chat would only show "Shofer wants to use Ask Live Memory" and
			// the answer would be silently appended to the model's tool_result.
			const sayPayload = {
				tool: "askLiveMemory",
				question,
				answer: result.answer,
				contextFiles: result.contextFiles ?? [],
				timeoutMs: timeoutMs ?? 300000,
				durationMs: result.durationMs,
				tokensTotal: result.tokensUsed.total,
				costUSD: result.costSnapshot.sessionEstimatedCostUSD,
			}
			await task.say("tool", JSON.stringify(sayPayload))

			const output = `Live Memory Answer:
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
			await handleError("ask_live_memory", error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"ask_live_memory">): Promise<void> {
		const question: string | undefined = block.params.question

		const sharedMessageProps = {
			tool: "askLiveMemory",
			question: question,
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(() => {})
	}
}

export const askLiveMemoryTool = new AskLiveMemoryTool()
