import { TurnDrain } from "../drain.js"

/**
 * The graceful drain's registry and its bounded wait (`../drain.ts`).
 *
 * The invariants under test are the ones a shutdown gets wrong silently: an
 * observer counted as work (so every drain runs to its ceiling), a wait that
 * does not end when the last turn does (the same), a wait that does not end at
 * all (an unkillable process), and a deregistration that fires twice (an empty
 * registry that never wakes its waiter).
 *
 * Timers are real and tiny rather than faked: `settle` races a promise against a
 * timeout, and faking the clock would make the race resolve in whichever order
 * the fake advanced rather than the order the code produces.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("TurnDrain", () => {
	it("starts open, and counts a registered turn as in flight", () => {
		const drain = new TurnDrain()
		expect(drain.draining).toBe(false)
		expect(drain.inFlight).toBe(0)

		drain.registerTurn("task-a", () => {})
		expect(drain.inFlight).toBe(1)
		expect(drain.inFlightTasks()).toEqual(["task-a"])
	})

	it("deduplicates the task ids it reports, not the streams it waits on", () => {
		// Two streams on one task is legitimate (a controller re-attaching), and
		// the wait must cover both while the shutdown log names the task once.
		const drain = new TurnDrain()
		drain.registerTurn("task-a", () => {})
		drain.registerTurn("task-a", () => {})

		expect(drain.inFlight).toBe(2)
		expect(drain.inFlightTasks()).toEqual(["task-a"])
	})

	it("begin() refuses new turns and RELEASES the observers", async () => {
		// An observer is watching, not working: it has no turn boundary, so
		// waiting on one would make every drain run to its ceiling.
		const drain = new TurnDrain()
		let observerClosed = 0
		drain.registerObserver(() => observerClosed++)

		drain.begin()

		expect(drain.draining).toBe(true)
		expect(observerClosed).toBe(1)
		expect(await drain.settle({ graceMs: 1_000, settleMs: 0 })).toBe(0)
	})

	it("is idempotent: a second begin() does not re-close a released observer", () => {
		const drain = new TurnDrain()
		let observerClosed = 0
		drain.registerObserver(() => observerClosed++)

		drain.begin()
		drain.begin()

		expect(observerClosed).toBe(1)
	})

	it("resolves as soon as the last turn ends, well inside the grace", async () => {
		const drain = new TurnDrain()
		let closed = 0
		const endTurn = drain.registerTurn("task-a", () => closed++)

		const settled = drain.settle({ graceMs: 60_000, settleMs: 0 })
		await tick()
		endTurn()

		expect(await settled).toBe(0)
		// A turn that finished on its own is never closed by the drain.
		expect(closed).toBe(0)
	})

	it("closes what is still running when the grace elapses, and reports it", async () => {
		// The ceiling is the point: a turn parked on an ask is waiting for a human
		// who may never answer, and human latency must not become an
		// unterminatable process.
		const drain = new TurnDrain()
		let closed = 0
		drain.registerTurn("task-a", () => closed++)
		drain.registerTurn("task-b", () => closed++)

		expect(await drain.settle({ graceMs: 5, settleMs: 0 })).toBe(2)
		expect(closed).toBe(2)
		expect(drain.inFlight).toBe(0)
	})

	it("returns immediately, and skips the settle window, with nothing in flight", async () => {
		// The common case — an idle node — must not pay the store-teardown margin.
		const drain = new TurnDrain()
		const started = Date.now()

		expect(await drain.settle({ graceMs: 60_000, settleMs: 10_000 })).toBe(0)
		expect(Date.now() - started).toBeLessThan(1_000)
	})

	it("waits the settle window AFTER the last turn, for teardown it cannot see", async () => {
		// The turn's terminal event reaches the controller from inside the agent's
		// run; the persistence teardown that follows (a final write, a lease
		// release) happens after, and nothing here can observe it.
		const drain = new TurnDrain()
		const endTurn = drain.registerTurn("task-a", () => {})

		const started = Date.now()
		const settled = drain.settle({ graceMs: 60_000, settleMs: 40 })
		endTurn()
		await settled

		expect(Date.now() - started).toBeGreaterThanOrEqual(30)
	})

	it("survives a deregistration that fires twice", async () => {
		// A response closes for more than one reason, so the handler's cleanup can
		// run twice; a second run must not empty the registry a second time and
		// leave a waiter parked forever.
		const drain = new TurnDrain()
		const endA = drain.registerTurn("task-a", () => {})
		const endB = drain.registerTurn("task-b", () => {})

		const settled = drain.settle({ graceMs: 60_000, settleMs: 0 })
		endA()
		endA()
		expect(drain.inFlight).toBe(1)
		endB()

		expect(await settled).toBe(0)
	})

	it("deregistering an observer removes it from the release set", () => {
		const drain = new TurnDrain()
		let observerClosed = 0
		const detach = drain.registerObserver(() => observerClosed++)

		detach()
		drain.begin()

		expect(observerClosed).toBe(0)
	})
})
