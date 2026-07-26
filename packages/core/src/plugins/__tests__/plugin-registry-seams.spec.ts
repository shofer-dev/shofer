import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createInMemoryHost, setHost, type PluginContext, type PluginTaskControl } from "@shofer/types"

import { PluginRegistry, PLUGIN_HOOK_TIMEOUT_MS } from "../plugin-registry.js"

/** A `ctx.task` stand-in that only records what it was asked to do. */
function stubTaskControl(): PluginTaskControl & { markers: string[] } {
	const markers: string[] = []
	return {
		markers,
		async marker(input) {
			markers.push(input.text)
		},
		async listMarkers() {
			return []
		},
		async rewind() {},
	}
}

describe("PluginRegistry — registered context is merged into hook contexts", () => {
	beforeEach(() => setHost(createInMemoryHost()))

	it("hands a hook its registered capabilities plus the call site's situational fields", async () => {
		const reg = new PluginRegistry()
		const task = stubTaskControl()
		let seen: PluginContext | undefined
		await reg.register(
			{
				name: "p",
				lifecycle: {
					beforeToolCall: async (_name, _args, ctx) => {
						seen = ctx
						await ctx.task?.marker({ kind: "k", text: "from-hook" })
						return { allow: true }
					},
				},
			},
			{ task, config: { a: 1 }, workspacePath: "/ws" },
			{ lifecycle: true },
		)

		await reg.applyBeforeToolCall("write_to_file", {}, { taskId: "t1", turn: 3, cwd: "/ws/sub" })

		// Registered half — without the merge a hook could not reach its own capabilities.
		expect(seen?.config).toEqual({ a: 1 })
		expect(task.markers).toEqual(["from-hook"])
		// Situational half wins where both define a field.
		expect(seen?.taskId).toBe("t1")
		expect(seen?.turn).toBe(3)
		expect(seen?.cwd).toBe("/ws/sub")
		expect(seen?.workspacePath).toBe("/ws")
	})

	it("does not let an undefined situational field clobber a registered one", async () => {
		const reg = new PluginRegistry()
		let seen: PluginContext | undefined
		await reg.register(
			{ name: "p", onEvent: (_e, ctx) => void (seen = ctx) },
			{ workspacePath: "/ws" },
			{ lifecycle: true },
		)
		reg.dispatchEvent({ name: "e" }, { workspacePath: undefined, taskId: "t1" })
		expect(seen?.workspacePath).toBe("/ws")
		expect(seen?.taskId).toBe("t1")
	})
})

describe("PluginRegistry — per-plugin hook budget", () => {
	beforeEach(() => {
		setHost(createInMemoryHost())
		vi.useFakeTimers()
	})
	afterEach(() => vi.useRealTimers())

	it("lets a plugin that raised hookTimeoutMs finish work the default budget would kill", async () => {
		const reg = new PluginRegistry()
		let finished = false
		await reg.register(
			{
				name: "slow-but-declared",
				lifecycle: {
					beforeToolCall: async () => {
						await new Promise((resolve) => setTimeout(resolve, PLUGIN_HOOK_TIMEOUT_MS * 4))
						finished = true
						return { allow: true, modifiedArgs: { snapshotted: true } }
					},
				},
			},
			{},
			{ lifecycle: true, hookTimeoutMs: PLUGIN_HOOK_TIMEOUT_MS * 10 },
		)

		const promise = reg.applyBeforeToolCall("write_to_file", {})
		await vi.advanceTimersByTimeAsync(PLUGIN_HOOK_TIMEOUT_MS * 5)
		const result = await promise
		expect(finished).toBe(true)
		expect(result).toEqual({ allow: true, modifiedArgs: { snapshotted: true } })
	})

	it("still skips a plugin that exceeds its own raised budget", async () => {
		const reg = new PluginRegistry()
		await reg.register(
			{ name: "hangs", lifecycle: { beforeToolCall: () => new Promise(() => {}) } },
			{},
			{ lifecycle: true, hookTimeoutMs: PLUGIN_HOOK_TIMEOUT_MS * 2 },
		)
		const promise = reg.applyBeforeToolCall("write_to_file", { a: 1 })
		await vi.advanceTimersByTimeAsync(PLUGIN_HOOK_TIMEOUT_MS * 2 + 10)
		// Skipped ⇒ the call proceeds unmodified rather than hanging the agent loop.
		expect(await promise).toEqual({ allow: true, modifiedArgs: undefined })
	})
})

describe("PluginRegistry — onTimelineRewind / onTaskDeleted", () => {
	beforeEach(() => setHost(createInMemoryHost()))

	it("awaits rewind hooks in registration order and passes the merged context", async () => {
		const reg = new PluginRegistry()
		const order: string[] = []
		const seen: unknown[] = []
		for (const name of ["a", "b"]) {
			await reg.register(
				{
					name,
					lifecycle: {
						onTimelineRewind: async (info, ctx) => {
							order.push(name)
							seen.push({ info, config: ctx.config })
						},
					},
				},
				{ config: { p: name } },
				{ lifecycle: true },
			)
		}

		await reg.notifyTimelineRewind({ ts: 42, taskId: "t1", operation: "delete", restoreState: true })
		expect(order).toEqual(["a", "b"])
		expect(seen).toEqual([
			{ info: { ts: 42, taskId: "t1", operation: "delete", restoreState: true }, config: { p: "a" } },
			{ info: { ts: 42, taskId: "t1", operation: "delete", restoreState: true }, config: { p: "b" } },
		])
	})

	it("does not fire hooks of a plugin without permissions.lifecycle", async () => {
		const reg = new PluginRegistry()
		const fired: string[] = []
		await reg.register({ name: "ungranted", lifecycle: { onTaskDeleted: () => void fired.push("x") } }, {}, {})
		await reg.notifyTaskDeleted({ taskId: "t1" })
		expect(fired).toEqual([])
	})

	it("isolates a throwing rewind hook so the rewind still proceeds", async () => {
		const reg = new PluginRegistry()
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		await reg.register(
			{
				name: "bad",
				lifecycle: {
					onTimelineRewind: () => {
						throw new Error("boom")
					},
				},
			},
			{},
			{ lifecycle: true },
		)
		await expect(
			reg.notifyTimelineRewind({ ts: 1, taskId: "t", operation: "restore", restoreState: true }),
		).resolves.toBeUndefined()
		warnSpy.mockRestore()
	})
})

describe("PluginRegistry — request (plugin RPC)", () => {
	beforeEach(() => setHost(createInMemoryHost()))

	it("routes to the named plugin and returns its result with the merged context", async () => {
		const reg = new PluginRegistry()
		await reg.register(
			{
				name: "checkpoints",
				handleRequest: async (method, params, ctx) => ({ method, params, taskId: ctx.taskId, cfg: ctx.config }),
			},
			{ config: { timeoutSeconds: 15 } },
		)
		await reg.register({ name: "other", handleRequest: async () => "wrong plugin" })

		expect(await reg.request("checkpoints", "diff", { hash: "abc" }, { taskId: "t9" })).toEqual({
			method: "diff",
			params: { hash: "abc" },
			taskId: "t9",
			cfg: { timeoutSeconds: 15 },
		})
	})

	it("propagates a plugin error to the waiting caller instead of swallowing it", async () => {
		const reg = new PluginRegistry()
		await reg.register({
			name: "p",
			handleRequest: async () => {
				throw new Error("no such checkpoint")
			},
		})
		await expect(reg.request("p", "restore", {})).rejects.toThrow(/no such checkpoint/)
	})

	it("throws for an unregistered plugin or one with no handleRequest", async () => {
		const reg = new PluginRegistry()
		await reg.register({ name: "silent" })
		await expect(reg.request("missing", "m", {})).rejects.toThrow(/not registered/)
		await expect(reg.request("silent", "m", {})).rejects.toThrow(/does not implement handleRequest/)
	})
})
