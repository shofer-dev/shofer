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

/**
 * The remote branch: an id no local lookup resolves is offered to the registered
 * mailbox transports (step 5), and the mesh plugin claims agent ids.
 *
 * The property that matters most is the ORDER — local first, always — because a
 * transport that could capture a local id would silently route a message to
 * another pod for a task running right here.
 */
describe("SendMessageTool — remote routing over a mailbox transport", () => {
	let tool: SendMessageTool
	let sent: Envelope[]
	let transport: { canRoute: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }
	let deliverToTask: ReturnType<typeof vi.fn>
	let findMailboxTransport: ReturnType<typeof vi.fn>

	beforeEach(() => {
		tool = new SendMessageTool()
		sent = []
		deliverToTask = vi.fn(async (_id: string, envelope: Envelope) => envelope)
		transport = {
			canRoute: vi.fn(async () => true),
			send: vi.fn(async (envelope: Envelope) => {
				sent.push(envelope)
			}),
		}
		findMailboxTransport = vi.fn(async () => transport)
	})

	const buildProvider = (overrides: Record<string, any> = {}) => ({
		taskManager: {
			getManagedTaskInstance: vi.fn().mockReturnValue(undefined),
			getManagedTask: vi.fn().mockReturnValue(undefined),
			setState: vi.fn(),
		},
		// No history for anything: every id is a candidate for the transport.
		getTaskWithId: vi.fn(async () => {
			throw new Error("no such task")
		}),
		deliverToTask,
		findMailboxTransport,
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

	it("hands an unresolvable id to the transport and stamps the envelope a2a", async () => {
		const { callbacks, results } = buildCallbacks()
		await tool.execute({ to: "mesh-agent-9", body: "ping", kind: "request" }, buildTask(), callbacks)

		expect(findMailboxTransport).toHaveBeenCalledWith("mesh-agent-9")
		expect(sent).toHaveLength(1)
		expect(sent[0]).toMatchObject({ from: "caller-1", to: "mesh-agent-9", kind: "request", plane: "a2a" })
		// Nothing went into a local box.
		expect(deliverToTask).not.toHaveBeenCalled()
		expect(results[0]).toContain("over the agent mesh")
	})

	it("a LIVE local instance wins outright — no directory call is made for it", async () => {
		const provider = buildProvider({
			taskManager: {
				getManagedTaskInstance: vi.fn(() => ({ taskId: "peer-1", rootTaskId: "root-1" })),
				getManagedTask: vi.fn().mockReturnValue(undefined),
				setState: vi.fn(),
			},
		})
		const { callbacks } = buildCallbacks()
		await tool.execute({ to: "peer-1", body: "ping" }, buildTask({ provider }), callbacks)

		expect(deliverToTask).toHaveBeenCalledTimes(1)
		expect(transport.send).not.toHaveBeenCalled()
		// The common path pays nothing for the rare one.
		expect(findMailboxTransport).not.toHaveBeenCalled()
	})

	/**
	 * The live-verified defect: two pods of one worker pool share a Postgres task
	 * store, so a task running on the SIBLING pod has a history row here too. With
	 * history consulted first it was read as a dormant local task — refused with an
	 * in-process rule that means nothing across pods, and, on a waking delivery,
	 * rehydrated into a second live instance of somebody else's task.
	 */
	it("asks the transport BEFORE history, so a shared-store sibling is not mistaken for a local task", async () => {
		const getTaskWithId = vi.fn(async (id: string) => ({ historyItem: { id, rootTaskId: "another-root" } }))
		const provider = buildProvider({ getTaskWithId })
		const { callbacks, results } = buildCallbacks()
		await tool.execute({ to: "sibling-task", body: "ping", kind: "request" }, buildTask({ provider }), callbacks)

		expect(sent).toHaveLength(1)
		expect(sent[0]).toMatchObject({ to: "sibling-task", plane: "a2a" })
		// History was never consulted, so its foreign root never produced a refusal.
		expect(getTaskWithId).not.toHaveBeenCalled()
		expect(deliverToTask).not.toHaveBeenCalled()
		expect(results[0]).not.toContain("does not share your root task")
	})

	it("falls through to history when no transport claims the id — a dormant local task", async () => {
		findMailboxTransport = vi.fn(async () => undefined)
		const getTaskWithId = vi.fn(async (id: string) => ({ historyItem: { id, rootTaskId: "root-1" } }))
		const provider = buildProvider({ getTaskWithId })
		const { callbacks } = buildCallbacks()
		await tool.execute({ to: "peer-1", body: "ping" }, buildTask({ provider }), callbacks)

		expect(findMailboxTransport).toHaveBeenCalledWith("peer-1")
		expect(getTaskWithId).toHaveBeenCalledWith("peer-1")
		expect(deliverToTask).toHaveBeenCalledTimes(1)
		expect(transport.send).not.toHaveBeenCalled()
	})

	it("still applies the in-process ACL on the dormant-local branch", async () => {
		findMailboxTransport = vi.fn(async () => undefined)
		const provider = buildProvider({
			getTaskWithId: vi.fn(async (id: string) => ({ historyItem: { id, rootTaskId: "root-1" } })),
		})
		const { callbacks, results } = buildCallbacks()
		// knownPeers holds "peer-1" only, and this is a sub-task.
		await tool.execute({ to: "peer-9", body: "ping" }, buildTask({ provider }), callbacks)

		expect(results[0]).toContain("not in your allowed peer set")
		expect(deliverToTask).not.toHaveBeenCalled()
	})

	it("skips the in-process ACL for a remote send — the broker is the gate", async () => {
		const { callbacks, results } = buildCallbacks()
		// A sub-task (rootTaskId set) whose knownPeers does NOT contain the target,
		// and which shares no root with it: both in-process refusals, neither of
		// which can apply to a peer in another pod.
		await tool.execute({ to: "mesh-agent-9", body: "ping" }, buildTask(), callbacks)

		expect(sent).toHaveLength(1)
		expect(results[0]).not.toContain("allowed peer set")
		expect(results[0]).not.toContain("does not share your root task")
	})

	it("reports the transport's refusal to the agent rather than swallowing it", async () => {
		transport.send = vi.fn(async () => {
			throw new Error("the target agent is not attached to this broker")
		})
		const { callbacks, results } = buildCallbacks()
		await tool.execute({ to: "mesh-agent-9", body: "ping" }, buildTask(), callbacks)

		expect(results[0]).toContain("Could not deliver to agent mesh-agent-9")
		expect(results[0]).toContain("not attached")
	})

	it("still refuses an id no transport claims", async () => {
		findMailboxTransport = vi.fn(() => undefined)
		const { callbacks, results } = buildCallbacks()
		await tool.execute({ to: "nowhere", body: "ping" }, buildTask(), callbacks)

		expect(sent).toEqual([])
		expect(results[0]).toContain("no mesh transport claims it")
	})

	it("still refuses a send to itself before any lookup happens", async () => {
		const { callbacks, results } = buildCallbacks()
		await tool.execute({ to: "caller-1", body: "ping" }, buildTask(), callbacks)

		expect(findMailboxTransport).not.toHaveBeenCalled()
		expect(results[0]).toContain("Cannot send a message to yourself")
	})

	it("does not send when the approval is declined", async () => {
		const { callbacks } = buildCallbacks()
		callbacks.askApproval = vi.fn(async () => false)
		await tool.execute({ to: "mesh-agent-9", body: "ping" }, buildTask(), callbacks)
		expect(transport.send).not.toHaveBeenCalled()
	})
})
