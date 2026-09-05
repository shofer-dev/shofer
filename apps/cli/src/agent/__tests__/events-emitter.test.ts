// pnpm --filter @shofer/cli test src/agent/__tests__/events-emitter.test.ts

import {
	TypedEventEmitter,
	Observable,
	isSignificantStateChange,
	transitionedToWaiting,
	transitionedToRunning,
	streamingStarted,
	streamingEnded,
} from "../events.js"
import { AgentLoopState, type AgentStateInfo } from "../agent-state.js"

const stateInfo = (overrides: Partial<AgentStateInfo> = {}): AgentStateInfo => ({
	state: AgentLoopState.RUNNING,
	isWaitingForInput: false,
	isRunning: true,
	isStreaming: false,
	requiredAction: "none",
	description: "running",
	...overrides,
})

describe("TypedEventEmitter", () => {
	it("subscribes, unsubscribes via the returned function, and counts listeners", () => {
		const emitter = new TypedEventEmitter()
		const seen: string[] = []
		const off = emitter.on("taskCreated", (id) => seen.push(id))

		expect(emitter.listenerCount("taskCreated")).toBe(1)
		emitter.emit("taskCreated", "t1")
		off()
		emitter.emit("taskCreated", "t2")

		expect(seen).toEqual(["t1"])
		expect(emitter.listenerCount("taskCreated")).toBe(0)
	})

	it("supports once and explicit off", () => {
		const emitter = new TypedEventEmitter()
		const seen: string[] = []
		emitter.once("taskStarted", (id) => seen.push(`once:${id}`))
		emitter.emit("taskStarted", "a")
		emitter.emit("taskStarted", "b")

		const listener = (id: string) => seen.push(`on:${id}`)
		emitter.on("taskStarted", listener)
		emitter.off("taskStarted", listener)
		emitter.emit("taskStarted", "c")

		expect(seen).toEqual(["once:a"])
	})

	it("removes listeners for one event or for all events", () => {
		const emitter = new TypedEventEmitter()
		emitter.on("taskCreated", () => {})
		emitter.on("taskAborted", () => {})

		emitter.removeAllListeners("taskCreated")
		expect(emitter.listenerCount("taskCreated")).toBe(0)
		expect(emitter.listenerCount("taskAborted")).toBe(1)

		emitter.removeAllListeners()
		expect(emitter.listenerCount("taskAborted")).toBe(0)
	})
})

describe("state transition helpers", () => {
	it("detects a significant state change", () => {
		expect(isSignificantStateChange(stateInfo(), stateInfo())).toBe(false)
		expect(isSignificantStateChange(stateInfo(), stateInfo({ state: AgentLoopState.IDLE }))).toBe(true)
	})

	it("detects the waiting and running transitions", () => {
		const running = stateInfo()
		const waiting = stateInfo({ isWaitingForInput: true, isRunning: false })

		expect(transitionedToWaiting(running, waiting)).toBe(true)
		expect(transitionedToWaiting(waiting, waiting)).toBe(false)
		expect(transitionedToRunning(waiting, running)).toBe(true)
		expect(transitionedToRunning(running, running)).toBe(false)
		expect(transitionedToRunning(waiting, stateInfo({ isRunning: false }))).toBe(false)
	})

	it("detects streaming start and end", () => {
		const idle = stateInfo()
		const streaming = stateInfo({ isStreaming: true })

		expect(streamingStarted(idle, streaming)).toBe(true)
		expect(streamingStarted(streaming, streaming)).toBe(false)
		expect(streamingEnded(streaming, idle)).toBe(true)
		expect(streamingEnded(idle, idle)).toBe(false)
	})
})

describe("Observable", () => {
	it("replays the initial value to a new subscriber and pushes updates", () => {
		const observable = new Observable<number>(1)
		const seen: number[] = []
		const off = observable.subscribe((value) => seen.push(value))

		observable.next(2)
		expect(seen).toEqual([1, 2])
		expect(observable.getValue()).toBe(2)

		off()
		observable.next(3)
		expect(seen).toEqual([1, 2])
	})

	it("replays nothing when constructed with no value", () => {
		const observable = new Observable<number>()
		const seen: number[] = []
		observable.subscribe((value) => seen.push(value))
		expect(seen).toEqual([])
		expect(observable.getValue()).toBeUndefined()
	})

	it("reports and clears its subscribers", () => {
		const observable = new Observable<string>()
		expect(observable.hasSubscribers()).toBe(false)
		observable.subscribe(() => {})
		observable.subscribe(() => {})
		expect(observable.getSubscriberCount()).toBe(2)
		expect(observable.hasSubscribers()).toBe(true)

		observable.clear()
		expect(observable.getSubscriberCount()).toBe(0)
	})

	it("isolates a throwing observer from the others", () => {
		const observable = new Observable<number>()
		const seen: number[] = []
		const error = vi.spyOn(console, "error").mockImplementation(() => {})

		try {
			observable.subscribe(() => {
				throw new Error("bad observer")
			})
			observable.subscribe((value) => seen.push(value))
			observable.next(7)

			expect(seen).toEqual([7])
			expect(error).toHaveBeenCalled()
		} finally {
			error.mockRestore()
		}
	})
})
