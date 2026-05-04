/**
 * SkillUpdateTool — modify the SKILL.md body of an existing project skill.
 *
 * Skills live at `<project>/.roo/skills/<slug>/SKILL.md`. This tool exposes
 * three update modes (replace, append, patch) so the agent can iteratively
 * refine an authored runbook without recreating it from scratch.
 *
 * The tool only operates on already-existing skills — creation is owned by
 * authoring pipelines (e.g. browser-tools observe-mode), not by the model.
 */

import * as path from "path"
import * as fs from "fs/promises"

import type { ToolUse } from "../../shared/tools"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"

import { BaseTool, ToolCallbacks } from "./BaseTool"

type SkillUpdateMode = "replace" | "append" | "patch"

interface SkillUpdateParams {
	skill: string
	mode: SkillUpdateMode
	content?: string
	old_string?: string
	new_string?: string
}

/** Slug regex matches the SkillsManager / agent-skills spec. */
const SKILL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

export class SkillUpdateTool extends BaseTool<"skill_update"> {
	readonly name = "skill_update" as const

	async execute(params: SkillUpdateParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { skill: slug, mode, content, old_string, new_string } = params
		const { handleError, pushToolResult } = callbacks

		try {
			if (!slug) {
				return this.fail(
					task,
					pushToolResult,
					await task.sayAndCreateMissingParamError("skill_update", "skill"),
				)
			}
			if (!mode) {
				return this.fail(task, pushToolResult, await task.sayAndCreateMissingParamError("skill_update", "mode"))
			}
			if (!SKILL_SLUG_RE.test(slug) || slug.length > 80) {
				return this.fail(task, pushToolResult, formatResponse.toolError(`Invalid skill slug '${slug}'.`))
			}
			if (mode !== "replace" && mode !== "append" && mode !== "patch") {
				return this.fail(
					task,
					pushToolResult,
					formatResponse.toolError(`Invalid mode '${mode}'. Expected replace|append|patch.`),
				)
			}

			task.consecutiveMistakeCount = 0

			const provider = task.providerRef.deref()
			const cwd = provider?.cwd
			if (!cwd) {
				return this.fail(
					task,
					pushToolResult,
					formatResponse.toolError("No workspace folder open; skill_update requires a project."),
				)
			}

			const skillFile = path.join(cwd, ".roo", "skills", slug, "SKILL.md")

			let existing: string
			try {
				existing = await fs.readFile(skillFile, "utf-8")
			} catch {
				return this.fail(
					task,
					pushToolResult,
					formatResponse.toolError(
						`Skill '${slug}' not found at .roo/skills/${slug}/SKILL.md. skill_update only modifies existing skills.`,
					),
				)
			}

			let nextContent: string
			let summary: string
			switch (mode) {
				case "replace":
					if (content === undefined) {
						return this.fail(
							task,
							pushToolResult,
							formatResponse.toolError("mode=replace requires `content`."),
						)
					}
					nextContent = content
					summary = `Replaced entire SKILL.md (${nextContent.length} chars).`
					break
				case "append":
					if (content === undefined) {
						return this.fail(
							task,
							pushToolResult,
							formatResponse.toolError("mode=append requires `content`."),
						)
					}
					// Ensure separating newline between existing body and appended text.
					nextContent = existing.endsWith("\n") ? existing + content : existing + "\n" + content
					summary = `Appended ${content.length} chars to SKILL.md.`
					break
				case "patch": {
					if (old_string === undefined || new_string === undefined) {
						return this.fail(
							task,
							pushToolResult,
							formatResponse.toolError("mode=patch requires `old_string` and `new_string`."),
						)
					}
					const occurrences = countOccurrences(existing, old_string)
					if (occurrences === 0) {
						return this.fail(
							task,
							pushToolResult,
							formatResponse.toolError("Patch failed: `old_string` not found in SKILL.md."),
						)
					}
					if (occurrences > 1) {
						return this.fail(
							task,
							pushToolResult,
							formatResponse.toolError(
								`Patch failed: \`old_string\` matched ${occurrences} times; must be unique.`,
							),
						)
					}
					nextContent = existing.replace(old_string, new_string)
					summary = `Patched SKILL.md (1 occurrence replaced).`
					break
				}
			}

			const didApprove = await this.askToolApproval(callbacks, {
				tool: "updateSkill",
				path: path.relative(cwd, skillFile),
				content: summary,
			})
			if (!didApprove) {
				return
			}

			await fs.writeFile(skillFile, nextContent, "utf-8")
			pushToolResult(`${summary}\nFile: .roo/skills/${slug}/SKILL.md`)
		} catch (error) {
			await handleError("updating skill", error instanceof Error ? error : new Error(String(error)))
		}
	}

	private fail(task: Task, pushToolResult: (r: string) => void, message: string): void {
		task.consecutiveMistakeCount++
		task.recordToolError("skill_update")
		task.didToolFailInCurrentTurn = true
		pushToolResult(message)
	}

	override async handlePartial(task: Task, block: ToolUse<"skill_update">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "updateSkill",
			skill: block.params.skill ?? "",
			mode: block.params.mode ?? "",
		})
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0
	let count = 0
	let idx = 0
	while ((idx = haystack.indexOf(needle, idx)) !== -1) {
		count++
		idx += needle.length
	}
	return count
}

export const skillUpdateTool = new SkillUpdateTool()
