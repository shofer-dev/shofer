// npx vitest src/tools/__tests__/ReplyTool.spec.ts

import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"
import { randomUUID } from "crypto"

import type { Envelope } from "@shofer/types"

import { Mailbox } from "../../mailbox/Mailbox.js"
import { ReplyTool } from "../ReplyTool.js"

/**
 * `reply` — the answer half of the mailbox.
 *
 * The ordering test is the important one: the reply is DELIVERED before the
 * request is resolved out of the replier's box. Reversed, a refused delivery
 * would leave the replier with nothing to answer and the asker with no answer.
 */
describe("ReplyTool", () => {
	let tool: ReplyTool
	let storageRoot: string
	let mailbox: Mailbox
	let delivered: Array<{ taskId: string; envelope: Envelope }>
	let deliverToTask: ReturnType<typeof vi.fn>

	const NOW = () => Date.now()

	beforeEach(async () => {
		tool = new ReplyTool()
		storageRoot = path.join(os.tmpdir(), `shofer-reply-${randomUUID()}`)
		await fs.mkdir(storageRoot, { recursive: true })
		mailbox = new Mailbox("replier-1", storageRoot)
		delivered = []
		deliverToTask = vi.fn(async (taskId: string, envelope: Envelope) => {
			delivered.push({ taskId, envelope })
			return envelope
		})
	})

	afterEach(async () => {
		await fs.rm(storageRoot, { recursive: true, force: true })
	})

	const seedRequest = async (overrides: Partial<Envelope> = {}) => {
		const env = {
			id: overrides.id ?? "req-1",
			from: "asker-1",
			to: "replier-1",
			kind: "request",
			subject: "which table?",
			body: "which table does UserService use?",
			deadline: NOW() + 120_000,
			wake: true,
			sent_at: NOW(),
			plane: "local",
			...overrides,
		} as Envelope
		await mailbox.deliver(env)
		return env
	}

	const buildTask = () =>
		({
			taskId: "replier-1",
			rootTaskId: "root-1",
			mailbox,
			mailboxReady: Promise.resolve(),
			providerRef: { deref: () => ({ deliverToTask }) },
			emitTaskInteraction: vi.fn(async () => {}),
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

	it("delivers the reply to the asker and clears the request", async () => {
		const request = await seedRequest()
		const { callbacks, results } = buildCallbacks()

		await tool.execute({ replies: [{ message_id: "req-1", body: "the users table" }] }, buildTask(), callbacks)

		expect(delivered).toHaveLength(1)
		expect(delivered[0]!.taskId).toBe("asker-1")
		expect(delivered[0]!.envelope).toMatchObject({
			from: "replier-1",
			to: "asker-1",
			kind: "reply",
			in_reply_to: "req-1",
			body: "the users table",
			// A reply always wakes — the asker is entitled to the answer even if it
			// ended its turn in the meantime.
			wake: true,
		})
		// It outlives the question it answers.
		expect(delivered[0]!.envelope.deadline).toBeGreaterThanOrEqual(request.deadline)
		expect(mailbox.pending()).toHaveLength(0)
		expect(results[0]).toContain("req-1: answered asker-1")
	})

	it("delivers FIRST and resolves second — a refused delivery keeps the request answerable", async () => {
		await seedRequest()
		deliverToTask.mockRejectedValueOnce(new Error("Mailbox of task asker-1 is full"))
		const { callbacks, results } = buildCallbacks()

		await tool.execute({ replies: [{ message_id: "req-1", body: "the users table" }] }, buildTask(), callbacks)

		expect(results[0]).toContain("could not deliver to asker-1")
		// The whole point: the question is still there to be answered again.
		expect(mailbox.byKind("request").map((e) => e.id)).toEqual(["req-1"])
	})

	it("fails one item and lands the rest of the batch", async () => {
		await seedRequest({ id: "req-1" })
		await seedRequest({ id: "req-2", subject: "second" })
		const { callbacks, results } = buildCallbacks()

		await tool.execute(
			{
				replies: [
					{ message_id: "req-1", body: "one" },
					{ message_id: "nope", body: "two" },
					{ message_id: "req-2", body: "three" },
				],
			},
			buildTask(),
			callbacks,
		)

		expect(delivered.map((d) => d.envelope.in_reply_to)).toEqual(["req-1", "req-2"])
		expect(results[0]).toContain("nope: failed — no such request")
		expect(mailbox.pending()).toHaveLength(0)
	})

	it("fails an EXPIRED id rather than dropping the answer", async () => {
		await seedRequest({ id: "old", deadline: Date.now() - 1_000 })
		const { callbacks, results } = buildCallbacks()

		await tool.execute({ replies: [{ message_id: "old", body: "too late" }] }, buildTask(), callbacks)

		expect(deliverToTask).not.toHaveBeenCalled()
		expect(results[0]).toContain("old: failed — no such request")
	})

	it("refuses to answer a NOTIFICATION — only a request can be replied to", async () => {
		await seedRequest({ id: "note-1", kind: "notification", wake: false })
		const { callbacks, results } = buildCallbacks()

		await tool.execute({ replies: [{ message_id: "note-1", body: "hi" }] }, buildTask(), callbacks)

		expect(deliverToTask).not.toHaveBeenCalled()
		expect(results[0]).toContain("note-1: failed")
	})

	it("rejects an empty batch", async () => {
		const { callbacks, results } = buildCallbacks()
		await tool.execute({ replies: [] }, buildTask(), callbacks)
		expect(results[0]).toContain("Missing required parameter 'replies'")
	})

	it("does nothing when the approval is declined", async () => {
		await seedRequest()
		const { callbacks } = buildCallbacks()
		callbacks.askApproval = vi.fn(async () => false)
		await tool.execute({ replies: [{ message_id: "req-1", body: "x" }] }, buildTask(), callbacks)
		expect(deliverToTask).not.toHaveBeenCalled()
		expect(mailbox.byKind("request")).toHaveLength(1)
	})
})
