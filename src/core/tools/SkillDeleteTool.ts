/**
 * SkillDeleteTool — delete a project skill by removing its `.roo/skills/<slug>/`
 * directory.
 *
 * Mirrors `SkillSaveTool`: only project skills (under the open workspace) are
 * supported. The tool:
 *   1. Validates the slug.
 *   2. Verifies that `.roo/skills/<slug>/SKILL.md` exists (so a typo doesn't
 *      silently succeed against `force: true`).
 *   3. Requests approval with a `deleteSkill` say payload (this tool is
 *      destructive and intentionally NOT auto-approved by the auto-approval
 *      layer).
 *   4. Recursively removes the skill directory.
 *   5. Re-runs SkillsManager discovery so the webview reflects the change.
 */

import * as path from "path"
import * as fs from "fs/promises"

import type { ToolUse } from "../../shared/tools"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface SkillDeleteParams {
	skill: string
}

/** Slug regex matches the SkillsManager / agent-skills spec. */
const SKILL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

export class SkillDeleteTool extends BaseTool<"skill_delete"> {
	readonly name = "skill_delete" as const

	async execute(params: SkillDeleteParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { skill: slug } = params
		const { handleError, pushToolResult } = callbacks

		try {
			if (!slug) {
				return this.fail(
					task,
					pushToolResult,
					await task.sayAndCreateMissingParamError("skill_delete", "skill"),
				)
			}
			if (!SKILL_SLUG_RE.test(slug) || slug.length > 80) {
				return this.fail(task, pushToolResult, formatResponse.toolError(`Invalid skill slug '${slug}'.`))
			}

			task.consecutiveMistakeCount = 0

			const provider = task.providerRef.deref()
			const cwd = provider?.cwd
			if (!cwd) {
				return this.fail(
					task,
					pushToolResult,
					formatResponse.toolError("No workspace folder open; skill_delete requires a project."),
				)
			}

			const skillDir = path.join(cwd, ".roo", "skills", slug)
			const skillFile = path.join(skillDir, "SKILL.md")

			try {
				await fs.access(skillFile)
			} catch {
				return this.fail(
					task,
					pushToolResult,
					formatResponse.toolError(
						`Skill '${slug}' not found at .roo/skills/${slug}/SKILL.md; nothing to delete.`,
					),
				)
			}

			const summary = `Delete .roo/skills/${slug}/ (removes the entire skill directory).`

			const didApprove = await this.askToolApproval(callbacks, {
				tool: "deleteSkill",
				path: path.relative(cwd, skillDir),
				content: summary,
			})
			if (!didApprove) {
				return
			}

			await fs.rm(skillDir, { recursive: true, force: true })

			// Refresh SkillsManager so AVAILABLE SKILLS / webview reflect the deletion.
			await provider?.getSkillsManager()?.discoverSkills()

			pushToolResult(`Deleted skill '${slug}'.\nDirectory removed: .roo/skills/${slug}/`)
		} catch (error) {
			await handleError("deleting skill", error instanceof Error ? error : new Error(String(error)))
		}
	}

	private fail(task: Task, pushToolResult: (r: string) => void, message: string): void {
		task.consecutiveMistakeCount++
		task.recordToolError("skill_delete")
		task.didToolFailInCurrentTurn = true
		pushToolResult(message)
	}

	override async handlePartial(task: Task, block: ToolUse<"skill_delete">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "deleteSkill",
			skill: block.params.skill ?? "",
		})
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const skillDeleteTool = new SkillDeleteTool()
