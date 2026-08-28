// npx vitest src/tools/__tests__/SendMessageTool.spec.ts

import * as os from "os"
import * as path from "path"
import { randomUUID } from "crypto"

import type { Envelope } from "@shofer/types"

import { Mailbox } from "../../mailbox/Mailbox.js"
import { SendMessageTool } from "../SendMessageTool.js"

/**
 * `send_message` — the send half of the mailbox.
 *
 * What is pinned here is the VALIDATION ORDER and, above all, the ABSENCE of a
 * busy gate: the tool this one replaced refused a running, waiting or
 * waiting_input recipient, and the whole point of a mailbox is that a
 * recipient's state stops being the sender's problem.
 */
describe("SendMessageTool", () => {
	let tool: SendMessageTool
	let delivered: Array<{ taskId: string; envelope: Envelope }>
	let deliverToTask: ReturnType<typeof vi.fn>

	beforeEach(() => {
		tool = new SendMessageTool()
		delivered = []
		deliverToTask = vi.fn(async (taskId: string, envelope: Envelope) => {
			delivered.push({ taskId, envelope })
			return envelope
		})
	})

	const buildProvider = (overrides: Record<string, any> = {}) => ({
		taskManager: {
			getManagedTaskInstance: vi.fn().mockReturnValue(undefined),
			getManagedTask: vi.fn().mockReturnValue(undefined),
			setState: vi.fn(),
		},
		getTaskWithId: vi.fn(async (id: string) => ({ historyItem: { id, rootTaskId: "root-1" } })),
		deliverToTask,
		...overrides,
	})

	const buildTask = (overrides: Record<string, any> = {}) => {
		const provider = overrides.provider ?? buildProvider()
		return {
			taskId: "caller-1",
			rootTaskId: "root-1",
			knownPeers: new Set(["peer-1"]),
			providerRef: { deref: () => provider },
			emitTaskInteraction: vi.fn(async () => {}),
			...overrides,
		} as any
	}

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

	it("mints an envelope with the per-kind defaults and delivers it", async () => {
		const { callbacks, results } = buildCallbacks()
		const before = Date.now()
		await tool.execute({ to: "peer-1", body: "  hello   world  ", kind: "request" }, buildTask(), callbacks)

		expect(delivered).toHaveLength(1)
		const env = delivered[0]!.envelope
		expect(env).toMatchObject({ from: "caller-1", to: "peer-1", kind: "request", plane: "local" })
		// A request defaults to waking and to the 120 s request deadline.
		expect(env.wake).toBe(true)
		expect(env.deadline - before).toBeGreaterThanOrEqual(119_000)
		expect(env.deadline - before).toBeLessThanOrEqual(121_000)
		// An absent subject is derived from the body, whitespace-collapsed.
		expect(env.subject).toBe("hello world")
		expect(results[0]).toContain(`Sent request ${env.id} to peer-1`)
		// A request's result text teaches the idiom it exists for.
		expect(results[0]).toContain(`wait(in_reply_to="${env.id}")`)
	})

	it("defaults a notification to not waking, with the longer deadline", async () => {
		const { callbacks } = buildCallbacks()
		const before = Date.now()
		await tool.execute({ to: "peer-1", body: "fyi" }, buildTask(), callbacks)

		const env = delivered[0]!.envelope
		expect(env.kind).toBe("notification")
		expect(env.wake).toBe(false)
		expect(env.deadline - before).toBeGreaterThanOrEqual(599_000)
	})

	it("honours an explicit wake and timeout_sec", async () => {
		const { callbacks } = buildCallbacks()
		const before = Date.now()
		await tool.execute({ to: "peer-1", body: "fyi", wake: true, timeout_sec: 30 }, buildTask(), callbacks)

		const env = delivered[0]!.envelope
		expect(env.wake).toBe(true)
		expect(env.deadline - before).toBeLessThanOrEqual(31_000)
	})

	describe("validation order", () => {
		it("refuses a send to itself", async () => {
			const { callbacks, results } = buildCallbacks()
			await tool.execute({ to: "caller-1", body: "hi" }, buildTask(), callbacks)
			expect(results[0]).toContain("Cannot send a message to yourself")
			expect(deliverToTask).not.toHaveBeenCalled()
		})

		it("refuses an id this host cannot resolve", async () => {
			const provider = buildProvider({
				getTaskWithId: vi.fn(async () => {
					throw new Error("no such task")
				}),
			})
			const { callbacks, results } = buildCallbacks()
			await tool.execute({ to: "ghost", body: "hi" }, buildTask({ provider }), callbacks)
			expect(results[0]).toContain("not reachable from this host")
			expect(deliverToTask).not.toHaveBeenCalled()
		})

		it("refuses a target in another root", async () => {
			const provider = buildProvider({
				getTaskWithId: vi.fn(async (id: string) => ({ historyItem: { id, rootTaskId: "other-root" } })),
			})
			const { callbacks, results } = buildCallbacks()
			await tool.execute({ to: "peer-1", body: "hi" }, buildTask({ provider }), callbacks)
			expect(results[0]).toContain("does not share your root task")
		})

		it("refuses a peer outside a sub-task's granted set", async () => {
			const { callbacks, results } = buildCallbacks()
			await tool.execute(
				{ to: "stranger", body: "hi" },
				buildTask({ knownPeers: new Set(["peer-1"]) }),
				callbacks,
			)
			expect(results[0]).toContain("not in your allowed peer set")
		})

		it("lets the ROOT task address anything in its own tree without a grant", async () => {
			const { callbacks } = buildCallbacks()
			// A root task has no rootTaskId of its own; its id IS the root.
			await tool.execute(
				{ to: "peer-1", body: "hi" },
				buildTask({ taskId: "root-1", rootTaskId: undefined, knownPeers: undefined }),
				callbacks,
			)
			expect(delivered).toHaveLength(1)
		})

		it("reports a refused delivery instead of pretending it landed", async () => {
			deliverToTask.mockRejectedValueOnce(new Error("Mailbox of task peer-1 is full"))
			const { callbacks, results } = buildCallbacks()
			const task = buildTask()
			await tool.execute({ to: "peer-1", body: "hi" }, task, callbacks)
			expect(results[0]).toContain("Could not deliver to task peer-1")
			expect(results[0]).toContain("full")
			// A refused send draws no Sequence-view arrow.
			expect(task.emitTaskInteraction).not.toHaveBeenCalled()
		})
	})

	/**
	 * The busy gate is GONE. Each of these lifecycles was a hard refusal in the
	 * tool this replaced; all of them now deliver.
	 */
	it.each(["running", "waiting", "waiting_input", "completed", "idle"])(
		"delivers to a %s recipient — there is no busy gate",
		async (lifecycle) => {
			const provider = buildProvider()
			provider.taskManager.getManagedTask = vi.fn().mockReturnValue({ state: { lifecycle } })
			provider.taskManager.getManagedTaskInstance = vi
				.fn()
				.mockReturnValue({ taskId: "peer-1", rootTaskId: "root-1" })
			const { callbacks } = buildCallbacks()
			await tool.execute({ to: "peer-1", body: "hi", kind: "request" }, buildTask({ provider }), callbacks)
			expect(delivered).toHaveLength(1)
		},
	)

	it("does not deliver when the approval is declined", async () => {
		const { callbacks } = buildCallbacks()
		callbacks.askApproval = vi.fn(async () => false)
		await tool.execute({ to: "peer-1", body: "hi" }, buildTask(), callbacks)
		expect(deliverToTask).not.toHaveBeenCalled()
	})

	it("produces an envelope a real mailbox accepts", async () => {
		// The tool's output is validated by the box, not by this test's opinion of
		// it: an envelope the schema rejects would fail here rather than at runtime.
		const storageRoot = path.join(os.tmpdir(), `shofer-sendmsg-${randomUUID()}`)
		const box = new Mailbox("peer-1", storageRoot)
		const { callbacks } = buildCallbacks()
		await tool.execute({ to: "peer-1", body: "hi", kind: "request" }, buildTask(), callbacks)
		await expect(box.deliver(delivered[0]!.envelope)).resolves.toMatchObject({ kind: "request" })
	})
})
