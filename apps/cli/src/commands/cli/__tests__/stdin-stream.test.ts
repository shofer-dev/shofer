// pnpm --filter @shofer/cli test src/commands/cli/__tests__/stdin-stream.test.ts

import { EventEmitter } from "events"
import { PassThrough } from "stream"

import type { ShoferAsk } from "@shofer/types"

import type { ExtensionHost } from "@/agent/index.js"
import type { JsonEventEmitter } from "@/agent/json-event-emitter.js"

import { runStdinStreamMode } from "../stdin-stream.js"

/**
 * The NDJSON stdin stream protocol, driven end to end: a real `readline` over a
 * substituted `process.stdin`, a fake ExtensionHost whose ShoferApi calls are
 * recorded, and a fake JsonEventEmitter that captures every control/queue event.
 *
 * Nothing here spawns a process or touches a provider — the seams are the host's
 * four API methods (`runTask`, `sendMessage`, `cancelTask`, `respondToAsk`) and the
 * two event channels (`client` events, `extensionWebviewMessage`).
 */

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// One readline turn plus the microtasks the orchestrator queues behind it.
const settle = () => delay(20)

/**
 * Wait for an OBSERVABLE effect rather than for a duration. Anything the
 * orchestrator does behind an internal poll is awaited this way — a fixed sleep
 * sized to beat that poll is a race the moment the machine is loaded.
 */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) {
			return
		}
		await delay(5)
	}
	throw new Error(`timed out waiting for ${what}`)
}

interface ControlEvent {
	subtype: string
	requestId?: string
	command?: string
	taskId?: string
	content?: string
	success?: boolean
	code?: string
}

interface QueueEvent {
	subtype: string
	taskId?: string
	content?: string
	queueDepth: number
	queue: Array<{ id: string; text?: string; imageCount: number; timestamp?: number }>
}

function createFakeEmitter() {
	const control: ControlEvent[] = []
	const queue: QueueEvent[] = []
	const commandOutput: Array<{ kind: string; value?: string | number }> = []

	const emitter = {
		emitControl: (event: ControlEvent) => void control.push(event),
		emitQueue: (event: QueueEvent) => void queue.push(event),
		emitCommandOutputChunk: (output: string) => void commandOutput.push({ kind: "chunk", value: output }),
		markCommandOutputExited: (exitCode?: number) => void commandOutput.push({ kind: "exited", value: exitCode }),
		emitCommandOutputDone: (exitCode?: number) => void commandOutput.push({ kind: "done", value: exitCode }),
	}

	return { emitter: emitter as unknown as JsonEventEmitter, control, queue, commandOutput }
}

interface FakeHostOptions {
	/** Initial value of the mutable `activeTask` flag (cleared by `end()`). */
	activeTask?: boolean
	hasActiveTask?: () => boolean
	isWaitingForInput?: () => boolean
	currentAsk?: () => ShoferAsk | undefined
	runTask?: (prompt: string, taskId?: string, configuration?: unknown, images?: string[]) => Promise<void>
	cancelTask?: (taskId?: string) => void
	sendMessage?: (text?: string, images?: string[], taskId?: string) => void
	respondToAsk?: (response: unknown, taskId?: string) => Promise<void>
}

function createFakeHost(options: FakeHostOptions = {}) {
	const hostEvents = new EventEmitter()
	const clientEvents = new EventEmitter()

	const calls = {
		runTask: [] as Array<{ prompt: string; taskId?: string; configuration?: unknown; images?: string[] }>,
		sendMessage: [] as Array<{ text?: string; images?: string[]; taskId?: string }>,
		cancelTask: [] as Array<string | undefined>,
		respondToAsk: [] as Array<{ response: unknown; taskId?: string }>,
	}

	const state = {
		activeTask: options.activeTask ?? false,
		waiting: false,
		ask: undefined as ShoferAsk | undefined,
	}

	const host = {
		on: (event: string, listener: (...args: unknown[]) => void) => void hostEvents.on(event, listener),
		off: (event: string, listener: (...args: unknown[]) => void) => void hostEvents.off(event, listener),
		client: {
			on: (event: string, listener: (...args: unknown[]) => void) => {
				clientEvents.on(event, listener)
				return () => void clientEvents.off(event, listener)
			},
			hasActiveTask: () => (options.hasActiveTask ? options.hasActiveTask() : state.activeTask),
			getCurrentAsk: () => (options.currentAsk ? options.currentAsk() : state.ask),
			getAgentState: () => ({
				isWaitingForInput: options.isWaitingForInput ? options.isWaitingForInput() : state.waiting,
				currentAsk: options.currentAsk ? options.currentAsk() : state.ask,
			}),
		},
		isWaitingForInput: () => (options.isWaitingForInput ? options.isWaitingForInput() : state.waiting),
		runTask: async (prompt: string, taskId?: string, configuration?: unknown, images?: string[]) => {
			calls.runTask.push({ prompt, taskId, configuration, images })
			if (options.runTask) {
				return options.runTask(prompt, taskId, configuration, images)
			}
		},
		sendMessage: (text?: string, images?: string[], taskId?: string) => {
			calls.sendMessage.push({ text, images, taskId })
			options.sendMessage?.(text, images, taskId)
		},
		cancelTask: (taskId?: string) => {
			calls.cancelTask.push(taskId)
			options.cancelTask?.(taskId)
		},
		respondToAsk: async (response: unknown, taskId?: string) => {
			calls.respondToAsk.push({ response, taskId })
			if (options.respondToAsk) {
				return options.respondToAsk(response, taskId)
			}
		},
	}

	return {
		host: host as unknown as ExtensionHost,
		calls,
		state,
		emitClient: (event: string, payload?: unknown) => void clientEvents.emit(event, payload),
		emitExtensionMessage: (message: unknown) => void hostEvents.emit("extensionWebviewMessage", message),
		listenerCounts: () => ({
			host: hostEvents.listenerCount("extensionWebviewMessage"),
			clientError: clientEvents.listenerCount("error"),
			clientCompleted: clientEvents.listenerCount("taskCompleted"),
		}),
	}
}

interface Harness extends ReturnType<typeof createFakeHost> {
	stream: PassThrough
	control: ControlEvent[]
	queue: QueueEvent[]
	commandOutput: Array<{ kind: string; value?: string | number }>
	requestIds: Array<string | undefined>
	run: Promise<void>
	send: (command: Record<string, unknown>) => Promise<void>
	line: (raw: string) => Promise<void>
	/**
	 * Close stdin. By default this also clears the mutable `activeTask` flag,
	 * because `waitForTaskProgressAfterStdinClosed` polls forever while a task is
	 * reported active and not waiting — the run would never settle.
	 */
	end: (options?: { keepActive?: boolean }) => Promise<void>
}

let originalStdin: PropertyDescriptor | undefined
let openHarnesses: Harness[] = []

function startStream(hostOptions: FakeHostOptions = {}): Harness {
	const stream = new PassThrough()
	Object.defineProperty(process, "stdin", { value: stream, configurable: true, writable: true })

	const fakeHost = createFakeHost(hostOptions)
	const { emitter, control, queue, commandOutput } = createFakeEmitter()
	const requestIds: Array<string | undefined> = []

	const run = runStdinStreamMode({
		host: fakeHost.host,
		jsonEmitter: emitter,
		setStreamRequestId: (id) => void requestIds.push(id),
	})
	// Failures are asserted per test; keep the rejection from going unhandled.
	run.catch(() => {})

	const harness: Harness = {
		...fakeHost,
		stream,
		control,
		queue,
		commandOutput,
		requestIds,
		run,
		send: async (command) => {
			stream.write(`${JSON.stringify(command)}\n`)
			await settle()
		},
		line: async (raw) => {
			stream.write(`${raw}\n`)
			await settle()
		},
		end: async (endOptions) => {
			if (!endOptions?.keepActive) {
				fakeHost.state.activeTask = false
			}
			if (!stream.writableEnded) {
				stream.end()
			}
			await settle()
		},
	}

	openHarnesses.push(harness)
	return harness
}

beforeEach(() => {
	originalStdin = Object.getOwnPropertyDescriptor(process, "stdin")
	openHarnesses = []
})

afterEach(async () => {
	for (const harness of openHarnesses) {
		harness.state.activeTask = false
		if (!harness.stream.writableEnded) {
			harness.stream.end()
		}
		// Bounded: a run that cannot settle is a test bug, not a reason to wedge the file.
		await Promise.race([harness.run.catch(() => {}), delay(3_000)])
	}
	if (originalStdin) {
		Object.defineProperty(process, "stdin", originalStdin)
	}
})

const codes = (control: ControlEvent[]) => control.map((event) => `${event.subtype}:${event.code}`)

describe("runStdinStreamMode lifecycle", () => {
	it("fails when stdin closes with no command at all", async () => {
		const h = startStream()
		await h.end()
		await expect(h.run).rejects.toThrow("no stdin command provided")
	})

	it("skips blank lines and answers ping", async () => {
		const h = startStream()
		await h.line("")
		await h.line("   ")
		await h.send({ command: "ping", requestId: "p1" })
		await h.end()
		await h.run

		expect(codes(h.control)).toEqual(["ack:accepted", "done:pong"])
		expect(h.control.every((event) => event.requestId === "p1")).toBe(true)
	})

	it("rejects a malformed line with the parser's message", async () => {
		const h = startStream()
		await h.line("{not json")
		await h.end()
		await expect(h.run).rejects.toThrow("stdin command line 1: invalid JSON")
	})

	it("shuts down on request and stops reading further commands", async () => {
		const h = startStream()
		await h.send({ command: "shutdown", requestId: "s1" })
		await h.send({ command: "ping", requestId: "p2" })
		await h.end()
		await h.run

		expect(codes(h.control)).toEqual(["ack:accepted", "done:shutdown_requested"])
	})

	it("cancels a live task when shutting down", async () => {
		const h = startStream({ activeTask: true })
		await h.send({ command: "shutdown", requestId: "s2" })
		await h.end()
		await h.run

		expect(h.calls.cancelTask).toEqual([undefined])
	})

	it("unsubscribes from every channel when it finishes", async () => {
		const h = startStream()
		await h.send({ command: "ping", requestId: "p3" })
		await h.end()
		await h.run

		expect(h.listenerCounts()).toEqual({ host: 0, clientError: 0, clientCompleted: 0 })
	})
})

describe("runStdinStreamMode start", () => {
	it("acks, runs the task with the CLI terminal default, and awaits it", async () => {
		const h = startStream()
		await h.send({
			command: "start",
			requestId: "r1",
			prompt: "do it",
			taskId: "018f7fc8-7c96-7f7c-98aa-2ec4ff7f6d87",
			images: ["img"],
		})
		await h.end()
		await h.run

		expect(h.calls.runTask).toEqual([
			{
				prompt: "do it",
				taskId: "018f7fc8-7c96-7f7c-98aa-2ec4ff7f6d87",
				configuration: { terminalShellIntegrationDisabled: true },
				images: ["img"],
			},
		])
		expect(h.control[0]).toMatchObject({
			subtype: "ack",
			code: "accepted",
			command: "start",
			taskId: "018f7fc8-7c96-7f7c-98aa-2ec4ff7f6d87",
		})
		expect(h.requestIds).toContain("r1")
	})

	it("mints a task id when the command omits one, and honours explicit configuration", async () => {
		const h = startStream()
		await h.send({
			command: "start",
			requestId: "r2",
			prompt: "p",
			configuration: { terminalShellIntegrationDisabled: false, mode: "code" },
		})
		await h.end()
		await h.run

		expect(h.calls.runTask[0]?.taskId).toMatch(/^[0-9a-f-]{36}$/)
		expect(h.calls.runTask[0]?.configuration).toEqual({ terminalShellIntegrationDisabled: false, mode: "code" })
	})

	it("refuses a second start while the first is still active", async () => {
		let release = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let active = false
		const h = startStream({
			hasActiveTask: () => active,
			runTask: () => {
				active = true
				return gate.then(() => {
					active = false
				})
			},
		})

		await h.send({ command: "start", requestId: "a", prompt: "one" })
		await h.send({ command: "start", requestId: "b", prompt: "two" })
		release()
		await h.end()
		await h.run

		expect(h.calls.runTask).toHaveLength(1)
		const busy = h.control.find((event) => event.code === "task_busy")
		expect(busy).toMatchObject({ subtype: "error", requestId: "b", success: false })
	})

	it("waits for a settled previous task before starting the next", async () => {
		// The first task is held open by a gate rather than a timer, so the second
		// start cannot overtake it however slowly the machine reads stdin.
		let releaseFirst = () => {}
		const firstTask = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const order: string[] = []
		const h = startStream({
			// The client already reports no task while runTask's finalizers run — the
			// exact window `waitForPreviousTaskToSettle` exists to close.
			hasActiveTask: () => false,
			runTask: async (prompt) => {
				order.push(`start:${prompt}`)
				if (prompt === "one") {
					await firstTask
				}
				order.push(`end:${prompt}`)
			},
		})

		await h.send({ command: "start", requestId: "a", prompt: "one" })
		await h.send({ command: "start", requestId: "b", prompt: "two" })
		releaseFirst()
		await h.end()
		await h.run

		expect(h.calls.runTask).toHaveLength(2)
		expect(codes(h.control).filter((code) => code === "error:task_busy")).toHaveLength(0)
		expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"])
	})

	it("reports a fatal runTask failure and refuses the next command", async () => {
		const h = startStream({
			runTask: async () => {
				throw new Error("provider exploded")
			},
		})

		await h.send({ command: "start", requestId: "a", prompt: "one" })
		await h.send({ command: "ping", requestId: "b" })
		await h.end()

		await expect(h.run).rejects.toThrow("provider exploded")
		expect(h.control.find((event) => event.code === "task_error")).toMatchObject({
			subtype: "error",
			requestId: "a",
			content: "provider exploded",
		})
	})

	it("stringifies a non-Error runTask rejection", async () => {
		const h = startStream({
			runTask: async () => {
				throw "just a string"
			},
		})

		await h.send({ command: "start", requestId: "a", prompt: "one" })
		await h.send({ command: "ping", requestId: "b" })
		await h.end()
		await expect(h.run).rejects.toThrow("just a string")
		expect(h.control.find((event) => event.code === "task_error")?.content).toBe("just a string")
	})

	it("treats a cancellation rejection after a cancel as a clean abort", async () => {
		let active = false
		let fail: (error: Error) => void = () => {}
		const gate = new Promise<void>((_resolve, reject) => {
			fail = reject
		})
		const h = startStream({
			hasActiveTask: () => active,
			cancelTask: () => {
				active = false
				fail(new Error("Task was aborted"))
			},
			runTask: () => {
				active = true
				return gate
			},
		})

		await h.send({ command: "start", requestId: "a", prompt: "one" })
		await h.send({ command: "cancel", requestId: "c" })
		await h.end()
		await h.run

		expect(h.control.find((event) => event.code === "task_aborted")).toMatchObject({
			subtype: "done",
			requestId: "a",
			content: "task cancelled",
			success: false,
		})
		expect(h.requestIds).toContain(undefined)
	})

	it("swallows an expected control-flow rejection that is not a cancellation", async () => {
		let cancelled = false
		const h = startStream({
			hasActiveTask: () => !cancelled,
			cancelTask: () => {
				cancelled = true
			},
			runTask: async () => {
				await delay(40)
				throw new Error("no active task")
			},
		})

		await h.send({ command: "start", requestId: "a", prompt: "one" })
		await h.send({ command: "cancel", requestId: "c" })
		await h.end()
		await h.run

		// Cancel was requested, so the abort is reported once for the cancel command
		// and the task rejection is not escalated to a fatal error.
		expect(codes(h.control)).not.toContain("error:task_error")
	})
})

describe("runStdinStreamMode message", () => {
	it("refuses a message with no active task", async () => {
		const h = startStream({ hasActiveTask: () => false })
		await h.send({ command: "message", requestId: "m1", prompt: "hi" })
		await h.end()
		await h.run

		expect(h.control).toHaveLength(1)
		expect(h.control[0]).toMatchObject({ subtype: "error", code: "no_active_task", requestId: "m1" })
		expect(h.calls.sendMessage).toHaveLength(0)
	})

	it("acks, forwards and confirms a message on the addressed task", async () => {
		const h = startStream({ activeTask: true })
		await h.send({
			command: "message",
			requestId: "m2",
			prompt: "more",
			images: ["i"],
			taskId: "018f7fc8-7c96-7f7c-98aa-2ec4ff7f6d87",
		})
		await h.end()
		await h.run

		expect(codes(h.control)).toEqual(["ack:accepted", "done:accepted"])
		expect(h.calls.sendMessage).toEqual([
			{ text: "more", images: ["i"], taskId: "018f7fc8-7c96-7f7c-98aa-2ec4ff7f6d87" },
		])
	})

	it("re-attributes the stream to the message while the task waits for input", async () => {
		const h = startStream({ activeTask: true, isWaitingForInput: () => true })
		await h.send({ command: "message", requestId: "m3", prompt: "answer" })
		await h.end()
		await h.run

		expect(h.requestIds).toContain("m3")
	})

	it("waits for post-cancel rehydration before forwarding", async () => {
		let cancelled = false
		let resumable = false
		let recoveryPolls = 0
		const h = startStream({
			activeTask: true,
			// The recovery loop polls the agent state; the task is rehydrated by the
			// time it looks a second time. Flipping on the poll ITSELF — rather than
			// on a timer racing it — is what makes "not resumable yet, then
			// resumable" happen in a fixed order on any machine.
			isWaitingForInput: () => {
				recoveryPolls += 1
				if (recoveryPolls >= 2) {
					resumable = true
				}
				return resumable
			},
			currentAsk: () => (resumable ? ("resume_task" as ShoferAsk) : undefined),
			cancelTask: () => {
				cancelled = true
			},
		})

		await h.send({ command: "cancel", requestId: "c1" })
		expect(cancelled).toBe(true)
		await h.send({ command: "message", requestId: "m4", prompt: "after cancel" })
		await waitFor(() => h.calls.sendMessage.length === 1, "the post-cancel message to be forwarded")
		await h.end()
		await h.run

		expect(recoveryPolls).toBeGreaterThanOrEqual(2)
		expect(h.calls.sendMessage).toEqual([{ text: "after cancel", images: undefined, taskId: undefined }])
	})
})

describe("runStdinStreamMode cancel", () => {
	it("acks and reports a no-op cancel when nothing is in flight", async () => {
		const h = startStream({ hasActiveTask: () => false })
		await h.send({ command: "cancel", requestId: "c1" })
		await h.end()
		await h.run

		expect(codes(h.control)).toEqual(["ack:accepted", "done:no_active_task"])
		expect(h.calls.cancelTask).toHaveLength(0)
		expect(h.requestIds).toEqual(["c1"])
	})

	it("signals a cancel for a live task", async () => {
		const h = startStream({ activeTask: true })
		await h.send({ command: "cancel", requestId: "c2", taskId: "018f7fc8-7c96-7f7c-98aa-2ec4ff7f6d87" })
		await h.end()
		await h.run

		expect(codes(h.control)).toEqual(["ack:accepted", "done:cancel_requested"])
		expect(h.control[0]?.content).toBe("cancel requested")
		expect(h.calls.cancelTask).toEqual(["018f7fc8-7c96-7f7c-98aa-2ec4ff7f6d87"])
	})

	it("labels a cancel that lands before the task exists", async () => {
		let started = false
		const h = startStream({
			hasActiveTask: () => started,
			runTask: async () => {
				await delay(60)
				started = false
			},
		})

		await h.send({ command: "start", requestId: "s", prompt: "p" })
		await h.send({ command: "cancel", requestId: "c3" })
		await h.end()
		await h.run

		expect(h.control.find((event) => event.requestId === "c3")?.content).toBe("cancel requested (task starting)")
	})

	it("reports an already-settled task as a no-op cancel", async () => {
		const h = startStream({
			activeTask: true,
			cancelTask: () => {
				throw new Error("no active task to cancel")
			},
		})

		await h.send({ command: "cancel", requestId: "c4" })
		await h.end()
		await h.run

		const done = h.control.find((event) => event.subtype === "done")
		expect(done).toMatchObject({
			code: "no_active_task",
			content: "cancel ignored (task already settled)",
			success: true,
		})
	})

	it("reports a cancellation-shaped failure as handled", async () => {
		const h = startStream({
			activeTask: true,
			cancelTask: () => {
				throw new Error("AbortError: aborted")
			},
		})

		await h.send({ command: "cancel", requestId: "c5" })
		await h.end()
		await h.run

		const done = h.control.find((event) => event.subtype === "done")
		expect(done).toMatchObject({ code: "cancel_requested", content: "cancel handled" })
	})

	it("surfaces an unexpected cancel failure as an error", async () => {
		const h = startStream({
			activeTask: true,
			cancelTask: () => {
				throw new Error("disk on fire")
			},
		})

		await h.send({ command: "cancel", requestId: "c6" })
		await h.end()
		await h.run

		expect(h.control.find((event) => event.subtype === "error")).toMatchObject({
			code: "cancel_error",
			content: "disk on fire",
			success: false,
		})
	})

	it("stringifies a non-Error cancel failure", async () => {
		const h = startStream({
			activeTask: true,
			cancelTask: () => {
				throw 42
			},
		})

		await h.send({ command: "cancel", requestId: "c7" })
		await h.end()
		await h.run

		expect(h.control.find((event) => event.subtype === "error")?.content).toBe("42")
	})
})

describe("runStdinStreamMode ask", () => {
	it("refuses an ask with no task to address", async () => {
		const h = startStream()
		await h.send({ command: "ask", requestId: "k1", askResponse: "yesButtonClicked" })
		await h.end()
		await h.run

		expect(h.control).toHaveLength(1)
		expect(h.control[0]).toMatchObject({ subtype: "error", code: "no_active_task", taskId: undefined })
		expect(h.calls.respondToAsk).toHaveLength(0)
	})

	it("answers the addressed task's outstanding ask", async () => {
		const h = startStream()
		await h.send({
			command: "ask",
			requestId: "k2",
			askResponse: "messageResponse",
			text: "sure",
			images: ["i"],
			askId: "ask-1",
			mode: "code",
			taskId: "018f7fc8-7c96-7f7c-98aa-2ec4ff7f6d87",
		})
		await h.end()
		await h.run

		expect(codes(h.control)).toEqual(["ack:accepted", "done:accepted"])
		expect(h.calls.respondToAsk).toEqual([
			{
				response: {
					askResponse: "messageResponse",
					text: "sure",
					images: ["i"],
					askId: "ask-1",
					mode: "code",
				},
				taskId: "018f7fc8-7c96-7f7c-98aa-2ec4ff7f6d87",
			},
		])
	})

	it("falls back to the stream's current task", async () => {
		const h = startStream({ runTask: async () => void (await delay(5)) })
		await h.send({ command: "start", requestId: "s", prompt: "p", taskId: "018f7fc8-7c96-7f7c-98aa-2ec4ff7f6d87" })
		await h.send({ command: "ask", requestId: "k3", askResponse: "yesButtonClicked" })
		await h.end()
		await h.run

		expect(h.calls.respondToAsk[0]?.taskId).toBe("018f7fc8-7c96-7f7c-98aa-2ec4ff7f6d87")
	})
})

describe("runStdinStreamMode client events", () => {
	it("reports a task completion as done", async () => {
		const h = startStream({
			runTask: async () => {
				await delay(5)
				h.emitClient("taskCompleted", { success: true })
			},
		})

		await h.send({ command: "start", requestId: "r", prompt: "p" })
		await h.end()
		await h.run

		expect(h.control.find((event) => event.code === "task_completed")).toMatchObject({
			subtype: "done",
			content: "task completed",
			success: true,
		})
	})

	it("reports an unsuccessful completion as a failure", async () => {
		const h = startStream({
			runTask: async () => {
				await delay(5)
				h.emitClient("taskCompleted", { success: false })
			},
		})

		await h.send({ command: "start", requestId: "r", prompt: "p" })
		await h.end()
		await h.run

		expect(h.control.find((event) => event.code === "task_failed")).toMatchObject({ content: "task failed" })
	})

	it("reports an unsuccessful completion after a cancel as an abort", async () => {
		let done = () => {}
		const gate = new Promise<void>((resolve) => {
			done = resolve
		})
		let active = false
		const h = startStream({
			hasActiveTask: () => active,
			cancelTask: () => {
				active = false
				h.emitClient("taskCompleted", { success: false })
				done()
			},
			runTask: () => {
				active = true
				return gate
			},
		})

		await h.send({ command: "start", requestId: "r", prompt: "p" })
		await h.send({ command: "cancel", requestId: "c" })
		await h.end()
		await h.run

		expect(h.control.find((event) => event.code === "task_aborted")).toMatchObject({ content: "task cancelled" })
	})

	it("ignores a completion for a task the stream did not start", async () => {
		const h = startStream()
		await h.send({ command: "ping", requestId: "p" })
		h.emitClient("taskCompleted", { success: true })
		await settle()
		await h.end()
		await h.run

		expect(codes(h.control)).toEqual(["ack:accepted", "done:pong"])
	})

	it("escalates an unexpected client error and refuses the next command", async () => {
		const h = startStream()
		await h.send({ command: "ping", requestId: "p" })
		h.emitClient("error", new Error("socket died"))
		await settle()
		await h.send({ command: "ping", requestId: "p2" })
		await h.end()

		await expect(h.run).rejects.toThrow("socket died")
		expect(h.control.find((event) => event.code === "client_error")).toMatchObject({
			subtype: "error",
			content: "socket died",
		})
	})

	it("treats a cancellation client error on a cancelled start as a clean abort", async () => {
		let release = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let active = false
		const h = startStream({
			hasActiveTask: () => active,
			runTask: () => {
				active = true
				return gate
			},
			cancelTask: () => {
				active = false
			},
		})

		await h.send({ command: "start", requestId: "r", prompt: "p" })
		await h.send({ command: "cancel", requestId: "c" })
		h.emitClient("error", new Error("Task was cancelled"))
		await settle()
		release()
		await h.end()
		await h.run

		expect(h.control.find((event) => event.code === "task_aborted")).toMatchObject({
			subtype: "done",
			command: "start",
			content: "task cancelled",
		})
	})
})

describe("runStdinStreamMode command output relay", () => {
	async function withPing(fn: (h: Harness) => Promise<void>) {
		const h = startStream()
		await h.send({ command: "ping", requestId: "p" })
		await fn(h)
		await h.end()
		await h.run
		return h
	}

	it("streams output chunks", async () => {
		const h = await withPing(async (harness) => {
			harness.emitExtensionMessage({
				type: "commandExecutionStatus",
				text: JSON.stringify({ status: "output", output: "hello" }),
			})
			await settle()
		})
		expect(h.commandOutput).toEqual([{ kind: "chunk", value: "hello" }])
	})

	it("flushes the trailing output and marks the exit", async () => {
		const h = await withPing(async (harness) => {
			harness.emitExtensionMessage({
				type: "commandExecutionStatus",
				text: JSON.stringify({ status: "exited", output: "tail", exitCode: 3 }),
			})
			harness.emitExtensionMessage({
				type: "commandExecutionStatus",
				text: JSON.stringify({ status: "exited" }),
			})
			await settle()
		})
		expect(h.commandOutput).toEqual([
			{ kind: "chunk", value: "tail" },
			{ kind: "exited", value: 3 },
			{ kind: "exited", value: undefined },
		])
	})

	it("closes the output on timeout and on fallback", async () => {
		const h = await withPing(async (harness) => {
			harness.emitExtensionMessage({
				type: "commandExecutionStatus",
				text: JSON.stringify({ status: "timeout" }),
			})
			harness.emitExtensionMessage({
				type: "commandExecutionStatus",
				text: JSON.stringify({ status: "fallback" }),
			})
			await settle()
		})
		expect(h.commandOutput).toEqual([
			{ kind: "done", value: undefined },
			{ kind: "done", value: undefined },
		])
	})

	it("ignores malformed or irrelevant status payloads", async () => {
		const h = await withPing(async (harness) => {
			harness.emitExtensionMessage({ type: "commandExecutionStatus", text: 42 })
			harness.emitExtensionMessage({ type: "commandExecutionStatus", text: "{bad json" })
			harness.emitExtensionMessage({ type: "commandExecutionStatus", text: '"a string"' })
			harness.emitExtensionMessage({ type: "commandExecutionStatus", text: JSON.stringify({ status: 7 }) })
			harness.emitExtensionMessage({
				type: "commandExecutionStatus",
				text: JSON.stringify({ status: "started" }),
			})
			harness.emitExtensionMessage({ type: "commandExecutionStatus", text: JSON.stringify({ status: "output" }) })
			harness.emitExtensionMessage({ type: "somethingElse" })
			await settle()
		})
		expect(h.commandOutput).toEqual([])
	})
})

describe("runStdinStreamMode queue snapshots", () => {
	async function withQueue(fn: (h: Harness) => Promise<void>) {
		const h = startStream()
		await h.send({ command: "ping", requestId: "p" })
		await fn(h)
		await h.end()
		await h.run
		return h
	}

	const state = (messageQueue: unknown, extra: Record<string, unknown> = {}) => ({
		type: "state",
		state: { messageQueue, ...extra },
	})

	it("ignores a state message whose queue is not an array", async () => {
		const h = await withQueue(async (harness) => {
			harness.emitExtensionMessage(state(undefined))
			harness.emitExtensionMessage(state("nope"))
			harness.emitExtensionMessage({ type: "state" })
			await settle()
		})
		expect(h.queue).toEqual([])
	})

	it("stays silent for a first snapshot that is empty", async () => {
		const h = await withQueue(async (harness) => {
			harness.emitExtensionMessage(state([]))
			await settle()
		})
		expect(h.queue).toEqual([])
	})

	it("enqueues onto an empty baseline with nothing to promote", async () => {
		const h = await withQueue(async (harness) => {
			harness.emitExtensionMessage(state([]))
			harness.emitExtensionMessage(state([{ id: "a" }]))
			await settle()
		})
		expect(h.queue.map((event) => event.subtype)).toEqual(["enqueued"])
		expect(h.requestIds).toEqual([])
	})

	it("emits a first non-empty snapshot and normalizes its rows", async () => {
		const long = "y".repeat(400)
		const h = await withQueue(async (harness) => {
			harness.emitExtensionMessage(
				state(
					[
						"not a record",
						{ id: "" },
						{ noId: true },
						{ id: "a", text: "  spaced   out  ", images: ["x", "y"], timestamp: 5 },
						{ id: "b", text: "   ", timestamp: "bad" },
						{ id: "c", text: long },
						{ id: "d" },
					],
					{ currentTaskId: "task-1" },
				),
			)
			await settle()
		})

		expect(h.queue).toHaveLength(1)
		expect(h.queue[0]).toMatchObject({ subtype: "snapshot", queueDepth: 4, taskId: "task-1" })
		expect(h.queue[0]?.content).toBe("queue snapshot (4 items)")
		expect(h.queue[0]?.queue).toEqual([
			{ id: "a", text: "spaced out", imageCount: 2, timestamp: 5 },
			{ id: "b", text: undefined, imageCount: 0, timestamp: undefined },
			{ id: "c", text: `${"y".repeat(177)}...`, imageCount: 0, timestamp: undefined },
			{ id: "d", text: undefined, imageCount: 0, timestamp: undefined },
		])
	})

	it("reads the task id from currentTaskItem when currentTaskId is absent", async () => {
		const h = await withQueue(async (harness) => {
			harness.emitExtensionMessage({
				type: "state",
				state: { currentTaskItem: { id: "item-1" }, messageQueue: [{ id: "a" }] },
			})
			await settle()
		})
		expect(h.queue[0]?.taskId).toBe("item-1")
	})

	it("ignores a blank task id", async () => {
		const h = await withQueue(async (harness) => {
			harness.emitExtensionMessage({
				type: "state",
				state: { currentTaskId: "   ", messageQueue: [{ id: "a" }] },
			})
			await settle()
		})
		expect(h.queue[0]?.taskId).toBeUndefined()
	})

	it("labels enqueued, dequeued, updated and drained transitions", async () => {
		const h = await withQueue(async (harness) => {
			harness.emitExtensionMessage(state([{ id: "a" }]))
			harness.emitExtensionMessage(state([{ id: "a" }, { id: "b" }]))
			harness.emitExtensionMessage(state([{ id: "a" }, { id: "b" }])) // no change
			harness.emitExtensionMessage(state([{ id: "b" }, { id: "c" }])) // same depth, new ids
			harness.emitExtensionMessage(state([{ id: "c" }]))
			harness.emitExtensionMessage(state([]))
			await settle()
		})

		expect(h.queue.map((event) => `${event.subtype}:${event.queueDepth}`)).toEqual([
			"snapshot:1",
			"enqueued:2",
			"updated:2",
			"dequeued:1",
			"drained:0",
		])
		expect(h.queue.map((event) => event.content)).toEqual([
			"queue snapshot (1 item)",
			"queue enqueued (2 items)",
			"queue updated (2 items)",
			"queue dequeued (1 item)",
			"queue drained",
		])
	})
})

describe("runStdinStreamMode stdin EOF with a live task", () => {
	it("returns once the task finishes on its own", async () => {
		let active = true
		const h = startStream({ hasActiveTask: () => active, isWaitingForInput: () => false })
		await h.send({ command: "ping", requestId: "p" })
		setTimeout(() => {
			active = false
		}, 150)
		await h.end()
		await h.run

		expect(active).toBe(false)
	})

	it("accepts EOF at a stable idle completion boundary with an empty queue", async () => {
		const h = startStream({
			hasActiveTask: () => true,
			isWaitingForInput: () => true,
			currentAsk: () => "completion_result" as ShoferAsk,
		})
		await h.send({ command: "ping", requestId: "p" })
		h.emitExtensionMessage({ type: "state", state: { messageQueue: [] } })
		await settle()
		await h.end()
		await expect(h.run).resolves.toBeUndefined()
	})

	it("refuses EOF while the task is parked on an interactive ask", async () => {
		const h = startStream({
			hasActiveTask: () => true,
			isWaitingForInput: () => true,
			currentAsk: () => "followup" as ShoferAsk,
		})
		await h.send({ command: "ping", requestId: "p" })
		h.emitExtensionMessage({ type: "state", state: { messageQueue: [] } })
		await settle()
		await h.end()

		await expect(h.run).rejects.toThrow("stdin ended while task was waiting for input (followup)")
	})

	it("names an unknown ask in the refusal", async () => {
		const h = startStream({
			hasActiveTask: () => true,
			isWaitingForInput: () => true,
			currentAsk: () => undefined,
		})
		await h.send({ command: "ping", requestId: "p" })
		await h.end()

		await expect(h.run).rejects.toThrow("stdin ended while task was waiting for input (unknown)")
	})

	it("refuses EOF at an idle boundary that still has queued input", async () => {
		const h = startStream({
			hasActiveTask: () => true,
			isWaitingForInput: () => true,
			currentAsk: () => "completion_result" as ShoferAsk,
		})
		await h.send({ command: "ping", requestId: "p" })
		h.emitExtensionMessage({ type: "state", state: { messageQueue: [{ id: "queued" }] } })
		await settle()
		await h.end()

		await expect(h.run).rejects.toThrow("stdin ended while task was waiting for input (completion_result)")
	})

	it("refuses EOF when the task disappears mid-stability-check", async () => {
		// The idle boundary is only accepted when it is STABLE. The orchestrator
		// reads the ask exactly once to decide the boundary IS idle, then re-polls to
		// confirm; ending the task on that first read is precisely "it vanished
		// inside the window", and — unlike a timer racing the 2s poll — it cannot
		// land after the window has closed.
		let active = true
		let askReads = 0
		const h = startStream({
			hasActiveTask: () => active,
			isWaitingForInput: () => true,
			currentAsk: () => {
				askReads += 1
				if (askReads === 1) {
					active = false
				}
				return "resume_completed_task" as ShoferAsk
			},
		})
		await h.send({ command: "ping", requestId: "p" })
		h.emitExtensionMessage({ type: "state", state: { messageQueue: [] } })
		await settle()
		await h.end()

		await expect(h.run).rejects.toThrow("stdin ended while task was waiting for input (resume_completed_task)")
		// The refusal names the ask captured BEFORE the confirming poll.
		expect(askReads).toBe(1)
	})

	it("refuses EOF when the ask changes inside the stability window", async () => {
		// Same mechanism, the other instability: the confirming read sees a
		// different ask than the one that qualified the boundary.
		let askReads = 0
		const h = startStream({
			hasActiveTask: () => true,
			isWaitingForInput: () => true,
			currentAsk: () => {
				askReads += 1
				return (askReads === 1 ? "completion_result" : "followup") as ShoferAsk
			},
		})
		await h.send({ command: "ping", requestId: "p" })
		h.emitExtensionMessage({ type: "state", state: { messageQueue: [] } })
		await settle()
		await h.end()

		await expect(h.run).rejects.toThrow("stdin ended while task was waiting for input (completion_result)")
		expect(askReads).toBe(2)
	})

	it("returns when the task ends while EOF is waiting on an ask", async () => {
		// Active for the first few polls of the EOF resume window and then gone,
		// counted rather than timed: the inner poll breaks and the outer loop exits
		// without ever reaching the refusal.
		let polls = 0
		const h = startStream({
			hasActiveTask: () => {
				polls += 1
				return polls < 4
			},
			isWaitingForInput: () => true,
			currentAsk: () => "followup" as ShoferAsk,
		})
		await h.send({ command: "ping", requestId: "p" })
		await h.end()

		await expect(h.run).resolves.toBeUndefined()
	})
})
