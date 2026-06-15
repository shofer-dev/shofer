import { describe, it, expect } from "vitest"

import { getNativeTools } from "../index"

/**
 * `set_task_title` must be withheld from a task whose title was locked by its
 * spawning parent (via `new_task`'s `title`). The agent should never be offered
 * a tool it would only be refused — see SetTaskTitleTool / docs/native_tools.md
 * §`set_task_title` "Parent-locked titles".
 */
describe("getNativeTools — titleLocked", () => {
	const names = (titleLocked?: boolean) =>
		getNativeTools({ titleLocked }).map((t) => (t as any).function.name as string)

	it("includes set_task_title by default", () => {
		expect(names()).toContain("set_task_title")
		expect(names(false)).toContain("set_task_title")
	})

	it("omits set_task_title when the title is locked", () => {
		const locked = names(true)
		expect(locked).not.toContain("set_task_title")
		// Only that one tool is dropped — everything else still present.
		expect(locked.length).toBe(names(false).length - 1)
		expect(locked).toContain("new_task")
	})
})
