// npx vitest src/tools/__tests__/WaitTool.spec.ts

import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"
import { randomUUID } from "crypto"

import type { Envelope } from "@shofer/types"

import { Mailbox } from "../../mailbox/Mailbox.js"
import { WaitTool } from "../WaitTool.js"

/**
 * `wait` — the read half of the mailbox.
 *
 * Four things are pinned, each of which the design depends on: the whole box is
 * returned regardless of any filter, a timeout on an empty box is a normal
 * answer, the `waiting` lifecycle is entered and left exactly once, and a Stop
 * unparks the tool instead of leaving it on its timer.
 */
describe("WaitTool", () => {
	let tool: WaitTool
	let storageRoot: string
	let mailbox: Mailbox
	let setState: ReturnType<typeof vi.fn>
	let says: Array<{ type: string; text: string }>

	beforeEach(async () => {
		tool = new WaitTool()
		storageRoot = path.join(os.tmpdir(), `shofer-wait-${randomUUID()}`)
		await fs.mkdir(storageRoot, { recursive: true })
		mailbox = new Mailbox("me-1", storageRoot)
		setState = vi.fn()
		says = []
	})

	afterEach(async () => {
		await fs.rm(storageRoot, { recursive: true, force: true })
	})

	const envelope = (overrides: Partial<Envelope> = {}): Envelope =>
		({
			id: overrides.id ?? randomUUID(),
			from: "peer-1",
			to: "me-1",
			kind: "notification",
			subject: "s",
			body: "b",
			deadline: Date.now() + 600_000,
			wake: false,
			sent_at: Date.now(),
			plane: "local",
			...overrides,
		}) as Envelope

	const buildTask = (overrides: Record<string, any> = {}) =>
		({
			taskId: "me-1",
			rootTaskId: "root-1",
			abort: false,
			abandoned: false,
			abortSignal: undefined,
			mailbox,
			mailboxReady: Promise.resolve(),
			providerRef: {
				deref: () => ({ taskManager: { setState, getManagedTask: vi.fn().mockReturnValue(undefined) } }),
			},
			say: vi.fn(async (type: string, text: string) => {
				says.push({ type, text })
			}),
			...overrides,
		}) as any

	const buildCallbacks = () => {
		const results: string[] = []
		return {
			results,
			callbacks: {
				askApproval: vi.fn(async () => true),
				handleError: vi.fn(async () => {}),
				pushToolResult: vi.fn((r: string) => results.push(r)),
			} as any,
		}
	}

	it("returns a non-empty box immediately and never enters `waiting`", async () => {
		await mailbox.deliver(envelope({ id: "n-1", body: "the news" }))
		const { callbacks, results } = buildCallbacks()

		await tool.execute({ timeout_sec: 0 }, buildTask(), callbacks)

		expect(results[0]).toContain("1 message(s) in your mailbox")
		expect(results[0]).toContain("the news")
		// Nothing was parked, so no lifecycle transition happened at all.
		expect(setState).not.toHaveBeenCalled()
	})

	it("consumes notifications and keeps requests, and says one row per envelope", async () => {
		await mailbox.deliver(envelope({ id: "n-1" }))
		await mailbox.deliver(envelope({ id: "r-1", kind: "request", wake: true }))
		const { callbacks, results } = buildCallbacks()
		const task = buildTask()

		await tool.execute({ timeout_sec: 0 }, task, callbacks)

		expect(results[0]).toContain("(1 awaiting your reply)")
		expect(says.map((s) => s.type)).toEqual(["peer_message", "peer_message"])
		expect(JSON.parse(says[0]!.text)).toMatchObject({ senderTaskId: "peer-1", kind: "notification" })
		// The request survives its own reading; the notification does not.
		expect(mailbox.pending().map((e) => e.id)).toEqual(["r-1"])
	})

	it("returns an empty list on timeout — not an error", async () => {
		const { callbacks, results } = buildCallbacks()
		await tool.execute({ timeout_sec: 0 }, buildTask(), callbacks)
		expect(results[0]).toContain("No mail after 0s")
		expect(results[0]).not.toContain("Error")
	})

	it("enters `waiting` while parked and returns to `running`", async () => {
		const { callbacks } = buildCallbacks()
		const task = buildTask()
		const pending = tool.execute({ timeout_sec: 5 }, task, callbacks)

		await vi.waitFor(() => expect(setState).toHaveBeenCalledWith("me-1", { lifecycle: "waiting" }))
		await mailbox.deliver(envelope({ id: "late" }))
		await pending

		expect(setState).toHaveBeenNthCalledWith(1, "me-1", { lifecycle: "waiting" })
		expect(setState).toHaveBeenNthCalledWith(2, "me-1", { lifecycle: "running" })
	})

	describe("filters are a wake CONDITION, never a filter on the result", () => {
		it("stays parked for a delivery that does not match", async () => {
			const { callbacks, results } = buildCallbacks()
			const task = buildTask()
			const pending = tool.execute({ timeout_sec: 5, from: ["wanted"] }, task, callbacks)

			await vi.waitFor(() => expect(setState).toHaveBeenCalledWith("me-1", { lifecycle: "waiting" }))
			await mailbox.deliver(envelope({ id: "irrelevant", from: "somebody-else" }))
			// Still parked: the condition was not met.
			expect(results).toHaveLength(0)

			await mailbox.deliver(envelope({ id: "match", from: "wanted" }))
			await pending

			// …and when it IS met, BOTH envelopes come back.
			expect(results[0]).toContain("2 message(s) in your mailbox")
			expect(results[0]).toContain("irrelevant")
			expect(results[0]).toContain("match")
		})

		it("unparks on the reply named by in_reply_to, and returns the whole box", async () => {
			await mailbox.deliver(envelope({ id: "unrelated" }))
			const { callbacks, results } = buildCallbacks()
			// A box that already holds something unrelated does NOT satisfy an
			// in_reply_to condition — otherwise the filter would be meaningless.
			const pending = tool.execute({ timeout_sec: 5, in_reply_to: "req-9" }, buildTask(), callbacks)

			await vi.waitFor(() => expect(setState).toHaveBeenCalledWith("me-1", { lifecycle: "waiting" }))
			await mailbox.deliver(envelope({ id: "the-reply", kind: "reply", in_reply_to: "req-9", wake: true }))
			await pending

			expect(results[0]).toContain("2 message(s)")
			expect(results[0]).toContain("unrelated")
		})
	})

	it("unparks on the task's own abort and produces no result on a dead task", async () => {
		const controller = new AbortController()
		const task = buildTask({ abortSignal: controller.signal })
		const { callbacks, results } = buildCallbacks()
		const pending = tool.execute({ timeout_sec: 30 }, task, callbacks)

		await vi.waitFor(() => expect(setState).toHaveBeenCalledWith("me-1", { lifecycle: "waiting" }))
		task.abort = true
		controller.abort()
		await pending

		expect(results).toHaveLength(0)
		// A stopped task must NOT be resurrected to `running` by the finally.
		expect(setState).toHaveBeenCalledTimes(1)
	})

	it("returns at once when the task was already aborted before parking", async () => {
		const controller = new AbortController()
		controller.abort()
		const task = buildTask({ abortSignal: controller.signal, abort: true })
		const { callbacks, results } = buildCallbacks()

		await tool.execute({ timeout_sec: 30 }, task, callbacks)
		expect(results).toHaveLength(0)
	})

	it("does nothing when the approval is declined", async () => {
		await mailbox.deliver(envelope({ id: "n-1" }))
		const { callbacks, results } = buildCallbacks()
		callbacks.askApproval = vi.fn(async () => false)
		await tool.execute({ timeout_sec: 0 }, buildTask(), callbacks)
		expect(results).toHaveLength(0)
		expect(mailbox.pending()).toHaveLength(1)
	})
})
