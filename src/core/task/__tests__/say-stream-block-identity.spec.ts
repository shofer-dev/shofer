// cd src && npx vitest run core/task/__tests__/say-stream-block-identity.spec.ts
// Prevent the transitive import graph from loading extension.ts,
// which pulls in WorkflowTask (which extends Task — circular).
vi.mock("../../../extension", () => ({}))


import type { ShoferMessage } from "@shofer/types"

vi.mock("../../../utils/logging/subsystems", () => ({
	taskLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	webviewLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { Task } from "../Task"

/**
 * Regression tests for the identity-based streaming-text finalization in
 * `Task.say()`.
 *
 * Root cause this guards against: `say("text", …)` is delivered in two phases —
 * a streaming `partial=true` phase and a single `partial=false` finalization.
 * The legacy implementation located the message to finalize via
 * `shoferMessages.at(-1)`, so any message appended in between (a `tool_result`,
 * an `error`, grounding sources, reasoning, …) defeated the merge and produced
 * a second, duplicate "Shofer said" bubble while stranding the original as
 * `partial:true` forever.
 *
 * The fix tags the streamed text message with a stable `streamBlockId` and
 * finalizes by identity, so finalization is position-independent.
 *
 * These tests invoke `Task.prototype.say` against a minimal mock `this` to
 * exercise the say() control flow in isolation, without constructing a full
 * Task.
 */

type SayThis = {
	abort: boolean
	taskId: string
	instanceId: string
	lastMessageTs: number
	shoferMessages: ShoferMessage[]
	addToShoferMessages: (m: ShoferMessage) => Promise<void>
	updateShoferMessage: (m: ShoferMessage) => void
	saveShoferMessages: () => Promise<void>
	_debouncedSaveShoferMessages: { cancel: () => void }
}

function makeSayContext(): SayThis {
	const ctx: SayThis = {
		abort: false,
		taskId: "test-task",
		instanceId: "test-instance",
		lastMessageTs: 0,
		shoferMessages: [],
		addToShoferMessages: async (m: ShoferMessage) => {
			ctx.shoferMessages.push(m)
		},
		updateShoferMessage: vi.fn(),
		saveShoferMessages: vi.fn().mockResolvedValue(undefined),
		_debouncedSaveShoferMessages: { cancel: vi.fn() },
	}
	return ctx
}

// Bind the real implementation onto the mock context.
function say(ctx: SayThis, ...args: Parameters<Task["say"]>): Promise<undefined> {
	return (Task.prototype.say as (...a: Parameters<Task["say"]>) => Promise<undefined>).apply(ctx as never, args)
}

const textMessages = (ctx: SayThis): ShoferMessage[] =>
	ctx.shoferMessages.filter((m) => m.type === "say" && m.say === "text")

describe("Task.say streamed-text block identity", () => {
	it("finalizes the original partial when a tool_result is appended in between", async () => {
		const ctx = makeSayContext()
		const blockId = "block-1"

		// Streaming phase: partial text bubble created with a stable id.
		await say(ctx, "text", "Hello", undefined, true, undefined, undefined, { streamBlockId: blockId })

		expect(textMessages(ctx)).toHaveLength(1)
		expect(textMessages(ctx)[0].partial).toBe(true)
		expect(textMessages(ctx)[0].streamBlockId).toBe(blockId)

		// An intervening message lands AFTER the partial text — this is exactly
		// what used to defeat the `at(-1)` based merge.
		await say(ctx, "tool_result", JSON.stringify({ tool: "read_file", output: "…" }))

		// Finalization phase for the SAME block id.
		await say(ctx, "text", "Hello", undefined, false, undefined, undefined, { streamBlockId: blockId })

		// Exactly one text bubble, finalized in place (no duplicate, not stranded).
		const texts = textMessages(ctx)
		expect(texts).toHaveLength(1)
		expect(texts[0].partial).toBe(false)
		expect(texts[0].text).toBe("Hello")
		// The intervening tool_result is still present and ordered before nothing new.
		expect(ctx.shoferMessages.filter((m) => m.say === "tool_result")).toHaveLength(1)
	})

	it("is idempotent when the same block id is finalized twice", async () => {
		const ctx = makeSayContext()
		const blockId = "block-2"

		await say(ctx, "text", "Hi", undefined, true, undefined, undefined, { streamBlockId: blockId })
		await say(ctx, "text", "Hi there", undefined, false, undefined, undefined, { streamBlockId: blockId })
		// Re-delivered finalization (e.g. stream-end after a mid-stream finalize).
		await say(ctx, "text", "Hi there", undefined, false, undefined, undefined, { streamBlockId: blockId })

		const texts = textMessages(ctx)
		expect(texts).toHaveLength(1)
		expect(texts[0].partial).toBe(false)
		expect(texts[0].text).toBe("Hi there")
	})

	it("keeps distinct block ids as separate messages", async () => {
		const ctx = makeSayContext()

		await say(ctx, "text", "first", undefined, true, undefined, undefined, { streamBlockId: "a" })
		await say(ctx, "text", "first", undefined, false, undefined, undefined, { streamBlockId: "a" })
		await say(ctx, "text", "second", undefined, true, undefined, undefined, { streamBlockId: "b" })
		await say(ctx, "text", "second", undefined, false, undefined, undefined, { streamBlockId: "b" })

		const texts = textMessages(ctx)
		expect(texts).toHaveLength(2)
		expect(texts.map((m) => m.text)).toEqual(["first", "second"])
		expect(texts.every((m) => m.partial === false)).toBe(true)
	})

	it("preserves legacy tail-position behavior when no block id is supplied", async () => {
		const ctx = makeSayContext()

		// Without a streamBlockId, an intervening message DOES break the merge
		// (legacy behavior, intentionally unchanged for non-streamed says).
		await say(ctx, "text", "Hello", undefined, true)
		await say(ctx, "tool_result", "x")
		await say(ctx, "text", "Hello", undefined, false)

		// Legacy path produces a second text message — preserved for callers
		// that don't opt into identity tracking.
		expect(textMessages(ctx)).toHaveLength(2)
	})
})
