import { Task } from "../task/Task"
import type { ToolUse } from "../../shared/tools"
import { BaseTool, ToolCallbacks } from "./BaseTool"

/**
 * Maximum sleep duration in seconds. Prevents the agent from sleeping
 * indefinitely while still allowing reasonable wait periods.
 */
const MAX_SLEEP_SECONDS = 300

/**
 * Minimum sleep duration in seconds. Prevents zero-duration sleeps
 * that would waste a tool call round-trip.
 */
const MIN_SLEEP_SECONDS = 0.1

interface SleepParams {
	seconds: number
}

export class SleepTool extends BaseTool<"sleep"> {
	readonly name = "sleep" as const

	async execute(params: SleepParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { seconds } = params
		const { pushToolResult, handleError } = callbacks

		try {
			// Validate the duration parameter.
			if (
				typeof seconds !== "number" ||
				!Number.isFinite(seconds) ||
				seconds < MIN_SLEEP_SECONDS ||
				seconds > MAX_SLEEP_SECONDS
			) {
				task.consecutiveMistakeCount++
				task.recordToolError("sleep")
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					`Invalid sleep duration: ${seconds}s. Must be a finite number between ${MIN_SLEEP_SECONDS} and ${MAX_SLEEP_SECONDS} seconds.`,
				)
				return
			}

			task.consecutiveMistakeCount = 0

			const clampedSeconds = Math.min(Math.max(seconds, MIN_SLEEP_SECONDS), MAX_SLEEP_SECONDS)
			const ms = Math.round(clampedSeconds * 1000)

			// Render a chat-row entry so the user sees the sleep has started.
			const didApprove = await this.askToolApproval(callbacks, {
				tool: "sleep",
				content: `Sleeping for ${clampedSeconds.toFixed(1)} second(s)`,
			})
			if (!didApprove) {
				return
			}

			// Poll `task.abort` flag every 100ms so the sleep exits promptly
			// when the user cancels the task or a cost limit triggers abort.
			const startTime = Date.now()
			const pollInterval = 100
			let remaining = ms

			while (remaining > 0) {
				if (task.abort) {
					pushToolResult(`Sleep interrupted: task was cancelled.`)
					return
				}
				const step = Math.min(remaining, pollInterval)
				await new Promise<void>((resolve) => setTimeout(resolve, step))
				remaining = ms - (Date.now() - startTime)
			}

			const actualSeconds = (Date.now() - startTime) / 1000
			pushToolResult(`Slept for ${actualSeconds.toFixed(1)} second(s).`)
		} catch (error) {
			await handleError("sleeping", error instanceof Error ? error : new Error(String(error)))
		}
	}

	// No handlePartial override needed — sleep has no streaming UI to show.
}

export const sleepTool = new SleepTool()
