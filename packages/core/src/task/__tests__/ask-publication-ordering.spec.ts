// Prevent the transitive import graph from loading extension.ts,
// which pulls in the extension entrypoint (circular).
vi.mock("../../../extension", () => ({}))

vi.mock("../../logging/subsystems.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../logging/subsystems.js")>()),
	taskLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	webviewLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
	configLog: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { ShoferEventName, setHost, createInMemoryHost, type ShoferMessage } from "@shofer/types"

import { Task } from "../Task.js"
import { TASK_PARTIAL_APPEND_THROTTLE_MS } from "../../constants.js"

/**
 * What a finalized ask is allowed to look like on the wire, and what a
 * subscriber is allowed to assume about the object it receives.
 *
 * Three defects composed into an approval storm on a remotely driven host: one
 * streamed tool call published up to ~90 `ask` chunks carrying the same `askId`
 * and the same final arguments, none of them stamped `autoApproved`, and the
 * controller opened a durable approval row for every one.
 *
 *  1. The partial→final branch of `Task.ask()` — the branch EVERY streamed
 *     native tool call takes — published the finalized ask before deciding
 *     auto-approval, leaving the decision to a fallback block that ran after
 *     the persist had already returned.
 *  2. `updateShoferMessage` emitted the LIVE message object, so a consumer that
 *     serializes later (an SSE writer, a queued store write) published whatever
 *     state the object had drifted to — a finalized, undecided ask.
 *  3. The partial-append throttle stamped its clock after the append RESOLVED,
 *     so a store slower than the window admitted every subsequent chunk and
 *     each admitted write pushed the next one later still.
 *
 * These tests pin all three, and the third is written as the doc's
 * positive-feedback scenario rather than as a unit of arithmetic.
 */

type FakePersistence = {
	appended: ShoferMessage[]
	appendTaskMessage: ReturnType<typeof vi.fn>
	/** Resolve every append still in flight. */
	drain: () => void
}

/** A store whose UI-message appends never resolve until `drain()` is called. */
const makeSlowPersistence = (): FakePersistence => {
	const pending: Array<() => void> = []
	const appended: ShoferMessage[] = []
	const appendTaskMessage = vi.fn(async (_taskId: string, message: ShoferMessage) => {
		appended.push(message)
		await new Promise<void>((resolve) => pending.push(resolve))
	})
	return {
		appended,
		appendTaskMessage,
		drain: () => {
			for (const resolve of pending.splice(0)) resolve()
		},
	}
}

/** Drain the microtask queue so fire-and-forget continuations have run. */
const flushAsync = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** A store that appends immediately. */
const makeFastPersistence = (): FakePersistence => {
	const appended: ShoferMessage[] = []
	const appendTaskMessage = vi.fn(async (_taskId: string, message: ShoferMessage) => {
		appended.push(message)
	})
	return { appended, appendTaskMessage, drain: () => {} }
}

type Shell = {
	task: Task
	emit: ReturnType<typeof vi.fn>
	persistence: FakePersistence
	/** Every `message` event payload the task emitted, in order. */
	emittedMessages: () => Array<{ action: string; message: ShoferMessage }>
}

const buildTaskShell = async (options: {
	state?: Record<string, unknown>
	persistence?: FakePersistence
	messages?: ShoferMessage[]
}): Promise<Shell> => {
	const persistence = options.persistence ?? makeFastPersistence()
	const task = Object.create(Task.prototype) as Task
	const emit = vi.fn()
	const provider = {
		getState: vi.fn(async () => options.state ?? {}),
		getCurrentTask: vi.fn(() => undefined),
		taskManager: { getFocusedTaskId: vi.fn(() => undefined) },
		postMessageToWebview: vi.fn(async () => {}),
	}

	;(task as any).taskId = "task-1"
	;(task as any).abort = false
	;(task as any).abandoned = false
	;(task as any).isBackground = false
	;(task as any).parentTaskId = undefined
	;(task as any).shoferMessages = options.messages ?? []
	;(task as any).askResponse = undefined
	;(task as any).askResponseText = undefined
	;(task as any).askResponseImages = undefined
	;(task as any).lastMessageTs = undefined
	;(task as any)._currentAskId = undefined
	;(task as any).isAwaitingAskResponse = false
	;(task as any).trustedReadPaths = []
	;(task as any).trustedWritePaths = []
	;(task as any)._lastPartialAppendTs = 0
	;(task as any)._tokenBearingMessageCount = 0
	;(task as any)._persistencePromise = Promise.resolve(persistence)
	;(task as any)._debouncedSaveShoferMessages = Object.assign(
		vi.fn(async () => {}),
		{ cancel: vi.fn() },
	)
	;(task as any).saveShoferMessages = vi.fn(async () => true)
	;(task as any).diagLog = vi.fn()
	;(task as any).emit = emit
	;(task as any).providerRef = { deref: () => provider }

	const { MessageQueueService } = await import("../../message-queue/MessageQueueService.js")
	;(task as any).messageQueueService = new MessageQueueService()

	return {
		task,
		emit,
		persistence,
		emittedMessages: () =>
			emit.mock.calls
				.filter((call) => call[0] === ShoferEventName.Message)
				.map((call) => call[1] as { action: string; message: ShoferMessage }),
	}
}

/** The streamed partial an auto-approvable tool call has already published. */
const partialToolAsk = (ts: number, tool: string): ShoferMessage => ({
	ts,
	type: "ask",
	ask: "tool",
	text: JSON.stringify({ tool }),
	partial: true,
})

describe("Task.ask() decides auto-approval before it publishes", () => {
	beforeEach(() => {
		setHost(createInMemoryHost())
	})

	it("stamps a streamed (partial→final) auto-approvable ask before any emission or persist", async () => {
		const ts = Date.now() - 1000
		const { task, persistence, emittedMessages } = await buildTaskShell({
			// `newTask` is gated by `alwaysAllowSubtasks`; the seeded L2 bundle
			// carries both keys, which is the posture the storm ran under.
			state: { autoApprovalEnabled: true, alwaysAllowSubtasks: true },
			messages: [partialToolAsk(ts, "newTask")],
		})

		const result = await task.ask("tool", JSON.stringify({ tool: "newTask", content: "spawn" }), false)

		expect(result.response).toBe("yesButtonClicked")

		// `updateShoferMessage` is deliberately not awaited by the finalize branch,
		// so its persist + emit land after `ask()` returns. That is precisely why
		// the decision has to be on the message BEFORE it is handed over.
		await flushAsync()

		// Nothing finalized reached a subscriber without the decision on it.
		const finalized = emittedMessages().filter((event) => event.message.partial === false)
		expect(finalized.length).toBeGreaterThan(0)
		for (const event of finalized) {
			expect(event.message.autoApproved).toBe(true)
			expect(event.message.isAnswered).toBe(true)
			expect(event.message.askId).toBeTruthy()
		}

		// …and nothing finalized was PERSISTED undecided either.
		const persistedFinal = persistence.appended.filter((message) => message.partial === false)
		expect(persistedFinal.length).toBeGreaterThan(0)
		for (const message of persistedFinal) {
			expect(message.autoApproved).toBe(true)
		}
	})

	it("decides once per ask — provider state is not re-read after the decision is published", async () => {
		const ts = Date.now() - 1000
		const { task } = await buildTaskShell({
			state: { autoApprovalEnabled: true, alwaysAllowSubtasks: true },
			messages: [partialToolAsk(ts, "newTask")],
		})
		const getState = (task as any).providerRef.deref().getState as ReturnType<typeof vi.fn>

		await task.ask("tool", JSON.stringify({ tool: "newTask", content: "spawn" }), false)

		expect(getState).toHaveBeenCalledTimes(1)
	})

	it("leaves a genuinely gated streamed ask outstanding, published exactly once and undecided", async () => {
		const ts = Date.now() - 1000
		const { task, emittedMessages } = await buildTaskShell({
			// Master gate off: an absent/false posture key DENIES auto-approval,
			// so this ask must park for a human or a controller.
			state: { autoApprovalEnabled: false },
			messages: [partialToolAsk(ts, "writeToFile")],
		})

		const pending = task.ask("tool", JSON.stringify({ tool: "writeToFile", path: "a.ts" }), false)
		const settled = await Promise.race([
			pending.then(() => "settled" as const),
			new Promise<"parked">((resolve) => setTimeout(() => resolve("parked"), 30)),
		])

		expect(settled).toBe("parked")

		const finalized = emittedMessages().filter((event) => event.message.partial === false)
		expect(finalized).toHaveLength(1)
		expect(finalized[0]!.message.autoApproved).toBeUndefined()
		expect(finalized[0]!.message.isAnswered).toBeUndefined()

		// One waiter, one answer: releasing it resolves the same invocation.
		;(task as any).askResponse = "yesButtonClicked"
		await expect(pending).resolves.toMatchObject({ response: "yesButtonClicked" })

		// Parking published nothing further — no second, differently-decided copy.
		expect(emittedMessages().filter((event) => event.message.partial === false)).toHaveLength(1)
	})

	it("stamps a single complete auto-approvable ask before addToShoferMessages, as before", async () => {
		const { task } = await buildTaskShell({
			state: { autoApprovalEnabled: true, alwaysAllowSubtasks: true },
		})
		const added: ShoferMessage[] = []
		;(task as any).addToShoferMessages = vi.fn(async (message: ShoferMessage) => {
			added.push({ ...message })
		})

		const result = await task.ask("tool", JSON.stringify({ tool: "newTask", content: "spawn" }))

		expect(result.response).toBe("yesButtonClicked")
		expect(added).toHaveLength(1)
		expect(added[0]).toMatchObject({ autoApproved: true, isAnswered: true })
	})
})

describe("Task message events carry a snapshot, not the live object", () => {
	beforeEach(() => {
		setHost(createInMemoryHost())
	})

	it("mutating the message after updateShoferMessage does not alter what a subscriber received", async () => {
		const { task, emittedMessages } = await buildTaskShell({})
		const message: ShoferMessage = { ts: 1, type: "ask", ask: "tool", text: "before", partial: true }

		await (task as any).updateShoferMessage(message)

		message.partial = false
		message.text = "after"
		message.askId = "ask-1"

		const received = emittedMessages()
		expect(received).toHaveLength(1)
		expect(received[0]!.message).toMatchObject({ text: "before", partial: true })
		expect(received[0]!.message.askId).toBeUndefined()
	})

	it("mutating the message while the append is still in flight does not alter the emission", async () => {
		const persistence = makeSlowPersistence()
		const { task, emittedMessages } = await buildTaskShell({ persistence })
		const message: ShoferMessage = { ts: 1, type: "ask", ask: "tool", text: "streaming", partial: true }

		const inFlight = (task as any).updateShoferMessage(message) as Promise<void>
		// Enough microtask turns for the queued publication to REACH the store
		// (`updateShoferMessage` enqueues on the per-task publish chain, so the
		// append starts a few continuations later); the slow store then holds it
		// in flight until `drain()`.
		await flushAsync()

		// This is the finalize branch overtaking a queued append: the object the
		// call was made about is mutated before the emission is reached.
		message.partial = false
		message.autoApproved = undefined
		message.text = "finalized"

		persistence.drain()
		await inFlight

		const received = emittedMessages()
		expect(received).toHaveLength(1)
		expect(received[0]!.message).toMatchObject({ text: "streaming", partial: true })
		expect(persistence.appended[0]).toMatchObject({ text: "streaming", partial: true })
	})

	it("mutating the message after addToShoferMessages does not alter what a subscriber received", async () => {
		const { task, emittedMessages } = await buildTaskShell({})
		const message: ShoferMessage = { ts: 2, type: "ask", ask: "tool", text: "created" }

		await (task as any).addToShoferMessages(message)
		message.text = "mutated"
		message.isAnswered = true

		const received = emittedMessages()
		expect(received).toHaveLength(1)
		expect(received[0]!.message).toMatchObject({ text: "created" })
		expect(received[0]!.message.isAnswered).toBeUndefined()
		// The live object is still the one held in the transcript.
		expect((task as any).shoferMessages[0]).toBe(message)
	})
})

describe("Task partial-append throttle measures intent, not store latency", () => {
	beforeEach(() => {
		setHost(createInMemoryHost())
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("bounds appends when the store is slower than the throttle window", async () => {
		const persistence = makeSlowPersistence()
		const { task } = await buildTaskShell({ persistence })
		const message: ShoferMessage = { ts: 1, type: "say", say: "text", text: "", partial: true }

		// A streamed tool call: a delta every 100 ms for a second, against a store
		// that resolves none of them. Under the old ordering (`_lastPartialAppendTs`
		// stamped after the await) the clock never advanced, so every delta enqueued
		// its own write and each one made the chain deeper — the positive feedback
		// that stalled a tool call for seconds.
		const deltas = 11
		const stepMs = 100
		const inFlight: Array<Promise<void>> = []
		for (let i = 0; i < deltas; i++) {
			message.text = "x".repeat(i)
			inFlight.push((task as any).updateShoferMessage(message))
			await flushAsync()
			vi.advanceTimersByTime(stepMs)
		}

		// Deltas land at t = 0,100,…,1000 against a 250 ms window, so the ones
		// admitted are t = 0, 300, 600, 900 — four, no matter how deep the store's
		// backlog gets. Eleven would mean the throttle stopped throttling.
		//
		// The admitted appends run one behind another on the per-task publish
		// chain (each publication waits out its predecessor's store write), so
		// the store must be drained repeatedly before the total is countable —
		// which is itself the ordering guarantee: a slow store delays
		// publications, it no longer reorders them.
		for (let i = 0; i <= deltas; i++) {
			persistence.drain()
			await flushAsync()
		}
		expect(persistence.appendTaskMessage).toHaveBeenCalledTimes(4)
		expect(TASK_PARTIAL_APPEND_THROTTLE_MS).toBe(250)

		await Promise.all(inFlight)
	})

	it("still appends the finalized state even when a partial was just written", async () => {
		const persistence = makeFastPersistence()
		const { task } = await buildTaskShell({ persistence })
		const message: ShoferMessage = { ts: 1, type: "say", say: "text", text: "a", partial: true }

		await (task as any).updateShoferMessage(message)
		expect(persistence.appendTaskMessage).toHaveBeenCalledTimes(1)

		// Well inside the window — a partial would be throttled out here.
		vi.advanceTimersByTime(10)
		await (task as any).updateShoferMessage({ ...message, text: "ab", partial: true })
		expect(persistence.appendTaskMessage).toHaveBeenCalledTimes(1)

		// The finalization is never throttled, which is what makes the dropped
		// intermediate partials harmless: the canonical value is always durable.
		await (task as any).updateShoferMessage({ ...message, text: "ab done", partial: false })
		expect(persistence.appendTaskMessage).toHaveBeenCalledTimes(2)
		expect(persistence.appended.at(-1)).toMatchObject({ text: "ab done", partial: false })
	})
})
