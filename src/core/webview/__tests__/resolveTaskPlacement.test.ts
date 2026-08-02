import { pluginRegistry } from "@shofer/core"

import { resolveTaskPlacement, adoptDispatchedTask } from "../resolveTaskPlacement"
import { TaskAttachmentManager } from "../../attach/TaskAttachmentManager"
import type { ShoferProvider } from "../ShoferProvider"

/**
 * The task-placement seam: core asks every plugin WHERE a task should run and takes
 * the first claim. The cases that matter are the three outcomes — claimed, failed,
 * unclaimed — because getting the middle one wrong silently runs work on the wrong
 * machine, which is the whole reason the seam exists.
 */

const provider = { cwd: "/ws", log: vi.fn() } as unknown as ShoferProvider

describe("resolveTaskPlacement", () => {
	beforeEach(() => vi.restoreAllMocks())

	it("returns undefined when no plugin answers — the in-process path runs unchanged", async () => {
		vi.spyOn(pluginRegistry, "requestAll").mockResolvedValue([])
		expect(await resolveTaskPlacement(provider, { prompt: "hi" })).toBeUndefined()
	})

	it("broadcasts the question with the prompt, mode, profile and resolved cwd", async () => {
		const requestAll = vi.spyOn(pluginRegistry, "requestAll").mockResolvedValue([])
		await resolveTaskPlacement(provider, {
			prompt: "hi",
			mode: "code",
			apiConfigName: "prod",
			cwd: "/ws/worktrees/a",
		})
		expect(requestAll).toHaveBeenCalledWith(
			"resolve-task-placement",
			{ prompt: "hi", mode: "code", apiConfigName: "prod", cwd: "/ws/worktrees/a" },
			{ cwd: "/ws/worktrees/a", workspacePath: "/ws" },
		)
	})

	it("returns the dispatched reference when a plugin claims the task", async () => {
		vi.spyOn(pluginRegistry, "requestAll").mockResolvedValue([
			{ dispatched: { taskId: "t7", address: "http://worker:30099", token: "s3cret" } },
		])
		expect(await resolveTaskPlacement(provider, { prompt: "hi" })).toEqual({
			taskId: "t7",
			address: "http://worker:30099",
			token: "s3cret",
		})
	})

	it("accepts a claim with no address — dispatched, just not watchable from here", async () => {
		vi.spyOn(pluginRegistry, "requestAll").mockResolvedValue([{ dispatched: { taskId: "t7" } }])
		expect(await resolveTaskPlacement(provider, { prompt: "hi" })).toEqual({ taskId: "t7" })
	})

	it("throws when a plugin recognised the question and failed", async () => {
		vi.spyOn(pluginRegistry, "requestAll").mockResolvedValue([{ error: "no worker is polling queue 'gpu'" }])
		await expect(resolveTaskPlacement(provider, { prompt: "hi" })).rejects.toThrow(
			"no worker is polling queue 'gpu'",
		)
	})

	it("takes the first well-formed answer and skips malformed ones", async () => {
		vi.spyOn(pluginRegistry, "requestAll").mockResolvedValue([
			{ somethingElse: true },
			{ dispatched: { taskId: "" } },
			{ dispatched: { taskId: "t9" } },
		])
		expect(await resolveTaskPlacement(provider, { prompt: "hi" })).toEqual({ taskId: "t9" })
	})
})

describe("adoptDispatchedTask", () => {
	afterEach(() => vi.restoreAllMocks())

	it("attaches to the dispatched task when the dispatcher named an address", async () => {
		const attach = vi.spyOn(TaskAttachmentManager.getInstance(), "attach").mockResolvedValue({} as never)
		expect(await adoptDispatchedTask(provider, { taskId: "t7", address: "http://w:1", token: "k" })).toBe(true)
		expect(attach).toHaveBeenCalledWith(provider, { address: "http://w:1", taskId: "t7", token: "k" })
	})

	it("records — but does not attach to — a dispatch with no address", async () => {
		const attach = vi.spyOn(TaskAttachmentManager.getInstance(), "attach")
		expect(await adoptDispatchedTask(provider, { taskId: "t7" })).toBe(false)
		expect(attach).not.toHaveBeenCalled()
	})
})
