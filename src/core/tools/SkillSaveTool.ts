/**
 * SkillSaveTool — create or update the SKILL.md body of a project skill.
 *
 * Skills live at `<project>/.roo/skills/<slug>/SKILL.md`. This tool exposes
 * three save modes:
 *
 *   - replace: overwrite the entire file with `content`. Creates the skill
 *              (and parent directory) if it doesn't exist yet — this is the
 *              intended path for authoring a new skill from scratch.
 *   - append:  append `content` to the end of the file. Creates the skill if
 *              missing, with `content` as the initial body.
 *   - patch:   replace `old_string` with `new_string` (must match exactly
 *              once). Requires the skill to already exist.
 *
 * The tool keeps a single, slug-qualified file per skill. It does not manage
 * mode associations or other metadata — those are handled by the
 * SkillsManager and the webview.
 */

import * as path from "path"
import * as fs from "fs/promises"

import type { ToolUse } from "../../shared/tools"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"

import { BaseTool, ToolCallbacks } from "./BaseTool"

type SkillSaveMode = "replace" | "append" | "patch"

interface SkillSaveParams {
	skill: string
	mode: SkillSaveMode
	content?: string
	old_string?: string
	new_string?: string
}

/** Slug regex matches the SkillsManager / agent-skills spec. */
const SKILL_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

export class SkillSaveTool extends BaseTool<"skill_save"> {
	readonly name = "skill_save" as const

	async execute(params: SkillSaveParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { skill: slug, mode, content, old_string, new_string } = params
		const { handleError, pushToolResult } = callbacks

		try {
			if (!slug) {
				return this.fail(
					task,
					pushToolResult,
					await task.sayAndCreateMissingParamError("skill_save", "skill"),
				)
			}
			if (!mode) {
				return this.fail(task, pushToolResult, await task.sayAndCreateMissingParamError("skill_save", "mode"))
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
					formatResponse.toolError("No workspace folder open; skill_save requires a project."),
				)
			}

			const skillDir = path.join(cwd, ".roo", "skills", slug)
			const skillFile = path.join(skillDir, "SKILL.md")

			let existing: string | null
			try {
				existing = await fs.readFile(skillFile, "utf-8")
			} catch {
				existing = null
			}
			const isCreating = existing === null

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
					summary = isCreating
						? `Created SKILL.md (${nextContent.length} chars).`
						: `Replaced entire SKILL.md (${nextContent.length} chars).`
					break
				case "append":
					if (content === undefined) {
						return this.fail(
							task,
							pushToolResult,
							formatResponse.toolError("mode=append requires `content`."),
						)
					}
					if (isCreating) {
						nextContent = content
						summary = `Created SKILL.md (${nextContent.length} chars).`
					} else {
						// Ensure separating newline between existing body and appended text.
						nextContent = existing!.endsWith("\n") ? existing + content : existing + "\n" + content
						summary = `Appended ${content.length} chars to SKILL.md.`
					}
					break
				case "patch": {
					if (existing === null) {
						return this.fail(
							task,
							pushToolResult,
							formatResponse.toolError(
								`Skill '${slug}' not found at .roo/skills/${slug}/SKILL.md. mode=patch requires an existing skill; use mode=replace to create one.`,
							),
						)
					}
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
				tool: "saveSkill",
				path: path.relative(cwd, skillFile),
				content: summary,
			})
			if (!didApprove) {
				return
			}

			if (isCreating) {
				await fs.mkdir(skillDir, { recursive: true })
			}
			await fs.writeFile(skillFile, nextContent, "utf-8")
			pushToolResult(`${summary}\nFile: .roo/skills/${slug}/SKILL.md`)
		} catch (error) {
			await handleError("saving skill", error instanceof Error ? error : new Error(String(error)))
		}
	}

	private fail(task: Task, pushToolResult: (r: string) => void, message: string): void {
		task.consecutiveMistakeCount++
		task.recordToolError("skill_save")
		task.didToolFailInCurrentTurn = true
		pushToolResult(message)
	}

	override async handlePartial(task: Task, block: ToolUse<"skill_save">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "saveSkill",
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

export const skillSaveTool = new SkillSaveTool()
