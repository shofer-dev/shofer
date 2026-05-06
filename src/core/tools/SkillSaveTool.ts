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
import matter from "gray-matter"

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

/** Max length of the `description` frontmatter field per agent-skills spec. */
const SKILL_DESCRIPTION_MAX_LEN = 1024

/**
 * Validate that `content` is a well-formed SKILL.md body for the given slug.
 * Enforces the same rules the SkillsManager uses to discover skills, so a
 * successful save is guaranteed to be loadable. Returns null on success or a
 * human-readable error string on failure.
 */
export function validateSkillFrontmatter(content: string, slug: string): string | null {
	// Require an opening `---` fence on the very first line. gray-matter is lenient
	// (it returns the whole body as `content` when no frontmatter is present), so
	// we check explicitly to give the model a precise error.
	if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
		return (
			"SKILL.md must start with a YAML frontmatter block delimited by `---` lines, " +
			`containing at minimum \`name: ${slug}\` and a \`description\` field.`
		)
	}

	let parsed: { data: Record<string, unknown> }
	try {
		parsed = matter(content) as { data: Record<string, unknown> }
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return `SKILL.md frontmatter is not valid YAML: ${message}`
	}

	const { data } = parsed

	const name = data.name
	if (typeof name !== "string" || name.length === 0) {
		return `SKILL.md frontmatter is missing the required \`name\` field (must equal the slug \`${slug}\`).`
	}
	if (name !== slug) {
		return (
			`SKILL.md frontmatter \`name: ${name}\` does not match the skill slug \`${slug}\`. ` +
			"The loader requires `name` to equal the parent directory name; otherwise the skill is silently dropped."
		)
	}

	const description = data.description
	if (typeof description !== "string") {
		return "SKILL.md frontmatter is missing the required `description` field (must be a non-empty string)."
	}
	const trimmed = description.trim()
	if (trimmed.length < 1 || trimmed.length > SKILL_DESCRIPTION_MAX_LEN) {
		return (
			`SKILL.md frontmatter \`description\` must be 1–${SKILL_DESCRIPTION_MAX_LEN} characters ` +
			`(got ${trimmed.length}).`
		)
	}

	return null
}

export class SkillSaveTool extends BaseTool<"skill_save"> {
	readonly name = "skill_save" as const

	async execute(params: SkillSaveParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { skill: slug, mode, content, old_string, new_string } = params
		const { handleError, pushToolResult } = callbacks

		try {
			if (!slug) {
				return this.fail(task, pushToolResult, await task.sayAndCreateMissingParamError("skill_save", "skill"))
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

			// Validate the resulting SKILL.md body. We always validate the final content
			// so the saved file is guaranteed to be discoverable by the loader. Skipping
			// validation only when appending to an already-valid file would still let a
			// bad append corrupt the frontmatter, so we validate unconditionally.
			const validationError = validateSkillFrontmatter(nextContent, slug)
			if (validationError !== null) {
				return this.fail(task, pushToolResult, formatResponse.toolError(validationError))
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
