/**
 * Unit tests for `SkillDeleteTool`.
 *
 * Mocks `fs/promises` so we can exercise the access/rm flow without touching
 * the real filesystem. Mirrors the structure of `skillSaveTool.spec.ts`.
 */

import { describe, expect, it, vi, beforeEach } from "vitest"
import * as fs from "fs/promises"

import { skillDeleteTool } from "../SkillDeleteTool"
import type { ToolUse } from "../../../shared/tools"
import type { Task } from "../../task/Task"

vi.mock("fs/promises", () => ({
	access: vi.fn(),
	rm: vi.fn(),
}))

describe("skillDeleteTool", () => {
	let task: any
	let callbacks: any
	let skillsManager: any

	beforeEach(() => {
		vi.clearAllMocks()

		skillsManager = {
			discoverSkills: vi.fn().mockResolvedValue(undefined),
		}

		task = {
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			recordToolError: vi.fn(),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter"),
			ask: vi.fn().mockResolvedValue({}),
			providerRef: {
				deref: vi.fn().mockReturnValue({
					cwd: "/workspace",
					getSkillsManager: vi.fn().mockReturnValue(skillsManager),
				}),
			},
		}

		callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}
	})

	const makeBlock = (skill?: string): ToolUse<"skill_delete"> => ({
		type: "tool_use" as const,
		name: "skill_delete" as const,
		params: skill === undefined ? {} : { skill },
		partial: false,
		nativeArgs: { skill: skill ?? "" },
	})

	it("fails when skill param is missing", async () => {
		await skillDeleteTool.handle(task as Task, makeBlock(""), callbacks)
		expect(task.recordToolError).toHaveBeenCalledWith("skill_delete")
		expect(task.sayAndCreateMissingParamError).toHaveBeenCalledWith("skill_delete", "skill")
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("Missing parameter")
		expect(fs.rm).not.toHaveBeenCalled()
	})

	it("fails on invalid slug", async () => {
		await skillDeleteTool.handle(task as Task, makeBlock("Invalid Slug!"), callbacks)
		expect(task.recordToolError).toHaveBeenCalledWith("skill_delete")
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("Invalid skill slug 'Invalid Slug!'"),
		)
		expect(fs.rm).not.toHaveBeenCalled()
	})

	it("fails when skill directory does not contain SKILL.md", async () => {
		;(fs.access as any).mockRejectedValueOnce(new Error("ENOENT"))
		await skillDeleteTool.handle(task as Task, makeBlock("ghost-skill"), callbacks)
		expect(task.recordToolError).toHaveBeenCalledWith("skill_delete")
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("not found"))
		expect(fs.rm).not.toHaveBeenCalled()
	})

	it("does not delete when user rejects approval", async () => {
		;(fs.access as any).mockResolvedValueOnce(undefined)
		callbacks.askApproval.mockResolvedValueOnce(false)

		await skillDeleteTool.handle(task as Task, makeBlock("my-skill"), callbacks)

		expect(fs.rm).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("deletes the skill directory and refreshes SkillsManager on success", async () => {
		;(fs.access as any).mockResolvedValueOnce(undefined)
		;(fs.rm as any).mockResolvedValueOnce(undefined)

		await skillDeleteTool.handle(task as Task, makeBlock("my-skill"), callbacks)

		expect(callbacks.askApproval).toHaveBeenCalledWith("tool", expect.stringContaining(`"tool":"deleteSkill"`))
		expect(fs.rm).toHaveBeenCalledWith(expect.stringContaining(".roo/skills/my-skill"), {
			recursive: true,
			force: true,
		})
		expect(skillsManager.discoverSkills).toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Deleted skill 'my-skill'"))
	})

	it("fails when no workspace is open", async () => {
		task.providerRef.deref = vi.fn().mockReturnValue({
			cwd: undefined,
			getSkillsManager: vi.fn().mockReturnValue(skillsManager),
		})

		await skillDeleteTool.handle(task as Task, makeBlock("my-skill"), callbacks)

		expect(task.recordToolError).toHaveBeenCalledWith("skill_delete")
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("No workspace folder open"))
		expect(fs.rm).not.toHaveBeenCalled()
	})
})
