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
		async setCwd() {},
		async openTask() {
			return "task-1"
		},
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

	it("delivers onAssistantMessage to granted plugins with the task context merged", async () => {
		const reg = new PluginRegistry()
		const seen: unknown[] = []
		await reg.register(
			{
				name: "observer",
				lifecycle: {
					onAssistantMessage: (info, ctx) => {
						seen.push({ info, taskId: ctx.taskId, turn: ctx.turn })
					},
				},
			},
			{},
			{ lifecycle: true },
		)
		await reg.register(
			{ name: "ungranted", lifecycle: { onAssistantMessage: () => void seen.push("never") } },
			{},
			{},
		)

		await reg.notifyAssistantMessage({ taskId: "t1", text: "let me run the tests", turn: 3 }, { turn: 3 })
		expect(seen).toEqual([{ info: { taskId: "t1", text: "let me run the tests", turn: 3 }, taskId: "t1", turn: 3 }])
	})

	it("brackets one LLM request with onApiRequestStart / onApiRequestFinish", async () => {
		const reg = new PluginRegistry()
		const seen: string[] = []
		await reg.register(
			{
				name: "meter",
				lifecycle: {
					onApiRequestStart: (info, ctx) =>
						void seen.push(`start:${info.model}:${info.requestIndex}:${ctx.mode}`),
					onApiRequestFinish: (info) => void seen.push(`finish:${info.requestIndex}:${info.ttfbMs}`),
				},
			},
			{},
			{ lifecycle: true },
		)

		await reg.notifyApiRequestStart(
			{ taskId: "t1", requestIndex: 0, model: "m", apiProtocol: "anthropic", retryAttempt: 0 },
			{ mode: "code" },
		)
		await reg.notifyApiRequestFinish({
			requestIndex: 0,
			taskId: "t1",
			parentTaskId: null,
			startedAtOffsetMs: 10,
			finishedAtOffsetMs: 900,
			ttfbMs: 120,
			genStartOffsetMs: 300,
			model: "m",
			apiProtocol: "anthropic",
			retryAttempt: 0,
			tokensIn: 1,
			tokensOut: 2,
			cacheWrites: 0,
			cacheReads: 0,
			cost: 0.5,
			status: "completed",
			toolSpans: [],
		})

		expect(seen).toEqual(["start:m:0:code", "finish:0:120"])
	})

	it("gives an afterAsk hook the ask id on its context as well as in the payload", async () => {
		const reg = new PluginRegistry()
		const seen: Array<{ askId?: string; ctxAskId?: string; decidedBy?: string }> = []
		await reg.register(
			{
				name: "verdicts",
				lifecycle: {
					afterAsk: (info, ctx) =>
						void seen.push({ askId: info.askId, ctxAskId: ctx.askId, decidedBy: info.decidedBy }),
				},
			},
			{},
			{ lifecycle: true },
		)

		await reg.notifyAfterAsk({
			taskId: "t1",
			askId: "ask-9",
			askType: "tool",
			outcome: "answered",
			response: "yesButtonClicked",
			decidedBy: "auto-approval",
			autoApproved: true,
		})

		expect(seen).toEqual([{ askId: "ask-9", ctxAskId: "ask-9", decidedBy: "auto-approval" }])
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
