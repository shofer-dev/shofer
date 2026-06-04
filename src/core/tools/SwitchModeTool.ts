import delay from "delay"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { getModeBySlug } from "../../shared/modes"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { getManagedTaskTitle } from "./helpers/managedTaskTitle"
import type { ToolUse } from "../../shared/tools"

interface SwitchModeParams {
	mode_slug: string
	reason: string
	task_id?: string
}

export class SwitchModeTool extends BaseTool<"switch_mode"> {
	readonly name = "switch_mode" as const

	async execute(params: SwitchModeParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { mode_slug, reason, task_id } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			if (!mode_slug) {
				task.consecutiveMistakeCount++
				task.recordToolError("switch_mode")
				pushToolResult(await task.sayAndCreateMissingParamError("switch_mode", "mode_slug"))
				return
			}

			task.consecutiveMistakeCount = 0

			// Verify the mode exists
			const targetMode = getModeBySlug(mode_slug, (await task.providerRef.deref()?.getState())?.customModes)

			if (!targetMode) {
				task.recordToolError("switch_mode")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(`Invalid mode: ${mode_slug}`))
				return
			}

			// --- Parent-switches-child path ---
			if (task_id) {
				return this.executeForChild(task_id, mode_slug, reason, task, targetMode, callbacks)
			}

			// --- Self-switch path (existing behaviour) ---
			// Check if already in requested mode — use the task's own mode,
			// not the provider-global mode, so parallel tasks don't interfere.
			const currentMode = await task.getTaskMode()

			if (currentMode === mode_slug) {
				task.recordToolError("switch_mode")
				task.didToolFailInCurrentTurn = true
				pushToolResult(`Already in ${targetMode.name} mode.`)
				return
			}

			const completeMessage = JSON.stringify({ tool: "switchMode", mode: mode_slug, reason })
			const didApprove = await askApproval("tool", completeMessage)

			if (!didApprove) {
				return
			}

			// Switch the mode using shared handler, scoped to this task
			// so background task A switching modes doesn't affect task B.
			await task.providerRef.deref()?.handleModeSwitch(mode_slug, task)

			pushToolResult(
				`Successfully switched from ${getModeBySlug(currentMode)?.name ?? currentMode} mode to ${
					targetMode.name
				} mode${reason ? ` because: ${reason}` : ""}.`,
			)

			await delay(500) // Delay to allow mode change to take effect before next tool is executed
		} catch (error) {
			await handleError("switching mode", error as Error)
		}
	}

	/**
	 * Switch the mode of a background child task identified by `task_id`.
	 * The calling task (parent) must own the child.
	 */
	private async executeForChild(
		task_id: string,
		mode_slug: string,
		reason: string,
		parentTask: Task,
		targetMode: { name: string },
		callbacks: ToolCallbacks,
	): Promise<void> {
		const { askApproval, pushToolResult } = callbacks

		// Locate the child handle in the parent's backgroundChildren map
		const handle = parentTask.backgroundChildren.get(task_id)
		if (!handle) {
			parentTask.consecutiveMistakeCount++
			parentTask.recordToolError("switch_mode")
			parentTask.didToolFailInCurrentTurn = true
			pushToolResult(formatResponse.toolError(`Task ${task_id} not found in background children.`))
			return
		}

		const provider = parentTask.providerRef.deref()
		if (!provider) {
			pushToolResult(formatResponse.toolError("Provider not available; cannot switch child task mode."))
			return
		}

		// Look up the live Task instance so we can apply handleModeSwitch on it
		const childTask = provider.taskManager.getManagedTaskInstance(task_id)
		if (!childTask) {
			pushToolResult(formatResponse.toolError(`Task ${task_id} is no longer running; cannot switch its mode.`))
			return
		}

		const currentMode = await childTask.getTaskMode()
		if (currentMode === mode_slug) {
			pushToolResult(
				`Child task "${getManagedTaskTitle(parentTask, task_id) ?? task_id}" is already in ${targetMode.name} mode.`,
			)
			return
		}

		const childTitle = getManagedTaskTitle(parentTask, task_id) ?? task_id
		const completeMessage = JSON.stringify({
			tool: "switchMode",
			mode: mode_slug,
			reason,
			task_id,
			child: childTitle,
		})
		const didApprove = await askApproval("tool", completeMessage)

		if (!didApprove) {
			return
		}

		await provider.handleModeSwitch(mode_slug, childTask)

		pushToolResult(
			`Successfully switched child task "${childTitle}" from ${
				getModeBySlug(currentMode)?.name ?? currentMode
			} mode to ${targetMode.name} mode${reason ? ` because: ${reason}` : ""}.`,
		)
	}

	override async handlePartial(task: Task, block: ToolUse<"switch_mode">): Promise<void> {
		const mode_slug: string | undefined = block.params.mode_slug
		const reason: string | undefined = block.params.reason
		const task_id: string | undefined = block.params.task_id

		const partialMessage = JSON.stringify({
			tool: "switchMode",
			mode: mode_slug ?? "",
			reason: reason ?? "",
			...(task_id ? { task_id } : {}),
		})

		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const switchModeTool = new SwitchModeTool()
