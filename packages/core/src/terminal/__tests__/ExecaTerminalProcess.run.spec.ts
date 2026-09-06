import type { ShoferTerminal } from "@shofer/types"

const execa = vi.fn()
// The class is declared INSIDE the factory: `vi.mock` is hoisted above every
// top-level binding, so a class defined out here is not initialized yet when
// the factory runs.
vi.mock("execa", () => {
	class ExecaError extends Error {
		exitCode?: number
		signal?: string
		constructor(message: string, exitCode?: number, signal?: string) {
			super(message)
			this.name = "ExecaError"
			this.exitCode = exitCode
			this.signal = signal
		}
	}
	return { execa: (...a: unknown[]) => execa(...a), ExecaError }
})

const psTree = vi.fn()
vi.mock("ps-tree", () => ({ default: (...a: unknown[]) => psTree(...a) }))

const terminateProcessTree = vi.fn()
vi.mock("../process-termination.js", () => ({
	terminateProcessTree: (...a: unknown[]) => terminateProcessTree(...a),
}))

import { ExecaError as FakeExecaError } from "execa"

import { ExecaTerminalProcess } from "../ExecaTerminalProcess.js"

/**
 * The headless (`execa`) terminal backend's process. It is the one Shofer runs
 * on a worker, so its lifecycle is what a background command's Stop button
 * actually reaches.
 *
 * Two behaviours are specific to running under a SHELL and are easy to get
 * wrong:
 *
 *  - the pid execa reports is the SHELL's, not the command's, so the real
 *    target is looked up through the process tree before anything is signalled.
 *    Killing the shell alone leaves the command running;
 *  - termination is SIGTERM to the whole tree with a grace window, then
 *    escalation — a well-behaved process gets to clean up, and `abort` waits
 *    for the pid lookup rather than signalling a pid it is about to replace.
 *
 * Output is RETRIEVED once and only at line boundaries, so a half-written line
 * is never handed to the model as if it were complete.
 */

/** A terminal-shaped stub, plus the stream it was handed. */
function fakeTerminal() {
	const streams: Array<AsyncIterable<string> | undefined> = []
	const terminal = {
		busy: true,
		getCurrentWorkingDirectory: () => "/ws",
		setActiveStream: vi.fn((stream: AsyncIterable<string> | undefined) => {
			streams.push(stream)
		}),
	}
	return { terminal: terminal as unknown as ShoferTerminal, streams, raw: terminal }
}

/**
 * An execa subprocess whose output stream yields `chunks`. When `holdOpen` is
 * set the stream stays open until `release()` is called, which is the only way
 * to observe the process WHILE it is running (abort, mid-run pid resolution) —
 * `run()` clears the subprocess reference on its way out.
 */
function stubSubprocess(chunks: unknown[], opts: { pid?: number; throws?: unknown; holdOpen?: boolean } = {}) {
	const kill = vi.fn()
	let release: (() => void) | undefined
	const gate = opts.holdOpen
		? new Promise<void>((resolve) => {
				release = resolve
			})
		: undefined

	const subprocess = {
		pid: opts.pid ?? 4242,
		kill,
		iterable: () =>
			(async function* () {
				if (opts.throws) throw opts.throws
				for (const c of chunks) yield c
				if (gate) await gate
			})(),
		then: undefined,
	}
	// `execa({...})` returns a template-tag function.
	execa.mockReturnValue(() => subprocess)
	return { subprocess, kill, release: () => release?.() }
}

/** Collect the `line` events a process emits — the buffer is drained into them. */
function collectLines(proc: ExecaTerminalProcess): string[] {
	const lines: string[] = []
	proc.on("line", (line) => lines.push(line))
	return lines
}

beforeEach(() => {
	vi.clearAllMocks()
	// No child processes by default: the shell pid stands.
	psTree.mockImplementation((_pid: number, cb: (err: unknown, children: unknown[]) => void) => cb(null, []))
})

describe("run", () => {
	it("runs under a shell in the terminal's directory, with stdin closed", async () => {
		stubSubprocess(["hello\n"])
		const { terminal } = fakeTerminal()

		await new ExecaTerminalProcess(terminal).run("echo hello")

		expect(execa).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/ws", all: true, stdin: "ignore", shell: true }),
		)
		// UTF-8 is forced so Ruby/CocoaPods-style tools do not mangle output.
		expect(execa.mock.calls[0]![0]).toMatchObject({ env: expect.objectContaining({ LANG: "en_US.UTF-8" }) })
	})

	it("hands the terminal a STRING stream even when execa yields bytes", async () => {
		stubSubprocess([new TextEncoder().encode("from bytes\n")])
		const { terminal, streams } = fakeTerminal()
		const proc = new ExecaTerminalProcess(terminal)
		const lines = collectLines(proc)

		await proc.run("echo x")

		expect(streams[0]).toBeDefined()
		expect(lines.join("")).toBe("from bytes\n")
	})

	it("publishes the stream with the SHELL's pid, then resolves the command's", async () => {
		// The lookup is asynchronous, so the stream is published first with what
		// execa reported; the resolved pid is what `abort` later signals.
		const sub = stubSubprocess(["x\n"], { pid: 100, holdOpen: true })
		psTree.mockImplementation((_pid: number, cb: (err: unknown, children: Array<{ PID: string }>) => void) =>
			cb(null, [{ PID: "200" }]),
		)
		const { terminal, raw } = fakeTerminal()
		const proc = new ExecaTerminalProcess(terminal)
		const run = proc.run("sleep 1")

		await vi.waitFor(() => expect(raw.setActiveStream).toHaveBeenCalledWith(expect.anything(), 100))
		await new Promise((r) => setTimeout(r, 150))
		proc.abort()
		sub.release()
		await run

		expect(terminateProcessTree).toHaveBeenCalledWith(200, expect.anything())
	})

	it("keeps the shell pid when the tree lookup fails or finds nothing", async () => {
		stubSubprocess(["x\n"], { pid: 100 })
		psTree.mockImplementation((_pid: number, cb: (err: unknown, children: unknown[]) => void) =>
			cb(new Error("no such process"), []),
		)
		const { terminal, raw } = fakeTerminal()

		await new ExecaTerminalProcess(terminal).run("sleep 1")

		expect(raw.setActiveStream).toHaveBeenCalledWith(expect.anything(), 100)
	})

	it("announces a clean completion and releases the terminal", async () => {
		stubSubprocess(["done\n"])

		void 0
		const { terminal, raw } = fakeTerminal()
		const proc = new ExecaTerminalProcess(terminal)
		const events: Array<[string, unknown]> = []
		proc.on("shell_execution_complete", (d) => events.push(["complete", d]))
		proc.on("completed", (o) => events.push(["completed", o]))
		proc.on("continue", () => events.push(["continue", undefined]))

		await proc.run("echo done")

		expect(events.map(([name]) => name)).toEqual(["complete", "completed", "continue"])
		expect(events[0]![1]).toEqual({ exitCode: 0 })
		expect(events[1]![1]).toBe("done\n")
		// The stream is withdrawn and the terminal freed.
		expect(raw.setActiveStream).toHaveBeenLastCalledWith(undefined)
		expect(raw.busy).toBe(false)
	})

	it("reports a non-zero exit and its signal", async () => {
		stubSubprocess([], {
			throws: new (FakeExecaError as unknown as new (m: string, c?: number, s?: string) => Error)(
				"Command failed",
				137,
				"SIGKILL",
			),
		})
		const { terminal } = fakeTerminal()
		const proc = new ExecaTerminalProcess(terminal)
		const complete = vi.fn()
		proc.on("shell_execution_complete", complete)

		await proc.run("false")

		expect(complete).toHaveBeenCalledWith({ exitCode: 137, signalName: "SIGKILL" })
	})

	it("reports an ordinary failure as exit code 1", async () => {
		stubSubprocess([], { throws: new Error("spawn ENOENT") })
		const { terminal } = fakeTerminal()
		const proc = new ExecaTerminalProcess(terminal)
		const complete = vi.fn()
		proc.on("shell_execution_complete", complete)

		await proc.run("nope")

		expect(complete).toHaveBeenCalledWith({ exitCode: 1 })
	})
})

describe("output retrieval", () => {
	it("hands over whole LINES only, withholding a partial trailing one", async () => {
		stubSubprocess(["first\nsecond\npartial without newline"])
		const { terminal } = fakeTerminal()
		const proc = new ExecaTerminalProcess(terminal)
		const lines = collectLines(proc)

		await proc.run("echo x")

		// A half-written line must never be presented to the model as complete.
		expect(lines.join("")).toBe("first\nsecond\n")
		expect(proc.hasUnretrievedOutput()).toBe(true)
	})

	it("returns each line ONCE — reading drains it", async () => {
		stubSubprocess(["line\n"])
		const { terminal } = fakeTerminal()
		const proc = new ExecaTerminalProcess(terminal)
		// Not listening: nothing drains the buffer during the run, so the
		// retrieval semantics are observable directly.
		proc.continue()

		await proc.run("echo x")

		expect(proc.hasUnretrievedOutput()).toBe(true)
		expect(proc.getUnretrievedOutput()).toBe("line\n")
		expect(proc.getUnretrievedOutput()).toBe("")
		expect(proc.hasUnretrievedOutput()).toBe(false)
	})
})

describe("continue", () => {
	it("stops listening and lets the caller's turn proceed", async () => {
		stubSubprocess(["x\n"])
		const { terminal } = fakeTerminal()
		const proc = new ExecaTerminalProcess(terminal)
		const onContinue = vi.fn()
		proc.on("continue", onContinue)

		proc.continue()

		expect(onContinue).toHaveBeenCalled()
		// Later output no longer reaches a `line` listener.
		const onLine = vi.fn()
		proc.on("line", onLine)
		await proc.run("echo x")
		expect(onLine).not.toHaveBeenCalled()
	})
})

describe("abort", () => {
	it("SIGTERMs the subprocess and escalates the whole tree", async () => {
		const sub = stubSubprocess(["x\n"], { pid: 100, holdOpen: true })
		const { terminal } = fakeTerminal()
		const proc = new ExecaTerminalProcess(terminal)
		const run = proc.run("sleep 100")
		await new Promise((r) => setTimeout(r, 150))

		proc.abort()
		sub.release()
		await run

		expect(sub.kill).toHaveBeenCalledWith("SIGTERM")
		expect(terminateProcessTree).toHaveBeenCalledWith(
			100,
			expect.objectContaining({ onError: expect.any(Function) }),
		)
	})

	it("waits for the pid lookup before signalling anything", async () => {
		const sub = stubSubprocess(["x\n"], { pid: 100, holdOpen: true })
		let resolveTree: (() => void) | undefined
		psTree.mockImplementation((_pid: number, cb: (err: unknown, children: Array<{ PID: string }>) => void) => {
			resolveTree = () => cb(null, [{ PID: "200" }])
		})
		const { terminal } = fakeTerminal()
		const proc = new ExecaTerminalProcess(terminal)
		const run = proc.run("sleep 100")

		// Stop pressed while the tree is still being walked.
		await new Promise((r) => setTimeout(r, 150))
		proc.abort()
		expect(terminateProcessTree).not.toHaveBeenCalled()

		resolveTree!()
		await new Promise((r) => setTimeout(r, 10))
		sub.release()
		await run

		// Signalled against the RESOLVED pid, not the shell's.
		expect(terminateProcessTree).toHaveBeenCalledWith(200, expect.anything())
	})

	it("survives a subprocess that refuses to be signalled", async () => {
		const sub = stubSubprocess(["x\n"], { pid: 100, holdOpen: true })
		sub.kill.mockImplementation(() => {
			throw new Error("already gone")
		})
		const { terminal } = fakeTerminal()
		const proc = new ExecaTerminalProcess(terminal)
		const run = proc.run("sleep 100")
		await new Promise((r) => setTimeout(r, 150))

		expect(() => proc.abort()).not.toThrow()
		sub.release()
		await run

		expect(terminateProcessTree).toHaveBeenCalled()
	})
})

describe("the terminal reference", () => {
	it("throws a clear error once the terminal has been collected", () => {
		const proc = new ExecaTerminalProcess({} as ShoferTerminal)
		;(proc as never as { terminalRef: { deref: () => undefined } }).terminalRef = { deref: () => undefined }

		expect(() => proc.terminal).toThrow(/Unable to dereference terminal/)
	})
})
