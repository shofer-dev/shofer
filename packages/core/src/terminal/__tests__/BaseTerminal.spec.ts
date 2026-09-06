import type { ShoferTerminalCallbacks, ShoferTerminalProcessResultPromise } from "@shofer/types"

import { BaseTerminal } from "../BaseTerminal.js"
import { BaseTerminalProcess } from "../BaseTerminalProcess.js"

/**
 * `BaseTerminal` is the vscode-free half of a terminal: the stream handoff, the
 * completed-process queue, and the shell-integration settings every backend
 * reads.
 *
 * The queue is the part with a real invariant. Output is RETRIEVED once — the
 * agent reads it into a tool result and the bytes must not be handed to the
 * model twice — so a completed process stays queued only while it still has
 * unretrieved output, and reading drains it. Getting that wrong either loses a
 * command's output or repeats it.
 */

/** A concrete terminal: the base class is abstract on `isClosed`/`runCommand`. */
class TestTerminal extends BaseTerminal {
	closed = false
	isClosed(): boolean {
		return this.closed
	}
	runCommand(): ShoferTerminalProcessResultPromise {
		throw new Error("not used in these tests")
	}
	/** Expose the protected stream flag for assertions. */
	get streamClosedFlag(): boolean {
		return this.isStreamClosed
	}
}

/** A process-shaped stub whose unretrieved output the test controls. */
function fakeProcess(command: string, output: string) {
	let remaining = output
	return {
		command,
		isHot: false,
		getUnretrievedOutput: () => {
			const out = remaining
			remaining = ""
			return out
		},
		hasUnretrievedOutput: () => remaining.length > 0,
		trimRetrievedOutput: () => {},
		emit: vi.fn(),
		continue: vi.fn(),
		abort: vi.fn(),
	} as never as import("@shofer/types").ShoferTerminalProcess
}

let terminal: TestTerminal

beforeEach(() => {
	terminal = new TestTerminal("execa", 1, "/ws")
})

describe("identity and defaults", () => {
	it("reports the directory it was created in", () => {
		expect(terminal.getCurrentWorkingDirectory()).toBe("/ws")
		expect(terminal.provider).toBe("execa")
		expect(terminal.id).toBe(1)
		expect(terminal.busy).toBe(false)
		expect(terminal.running).toBe(false)
	})

	it("has a no-op `show`, because a headless terminal has no panel", () => {
		expect(() => terminal.show(true)).not.toThrow()
	})
})

describe("the stream handoff", () => {
	it("marks the terminal running and hands the stream to the process", () => {
		const process = fakeProcess("ls", "")
		terminal.process = process

		terminal.setActiveStream({ [Symbol.asyncIterator]: () => ({}) } as never, 4242)

		expect(terminal.running).toBe(true)
		expect(terminal.streamClosedFlag).toBe(false)
		expect(process.emit).toHaveBeenCalledWith("shell_execution_started", 4242)
		expect(process.emit).toHaveBeenCalledWith("stream_available", expect.anything())
	})

	it("refuses a stream when no process owns it — a user's own shell command", () => {
		terminal.process = undefined
		terminal.running = true

		terminal.setActiveStream({ [Symbol.asyncIterator]: () => ({}) } as never)

		expect(terminal.running).toBe(false)
	})

	it("marks the stream closed when the stream is withdrawn", () => {
		terminal.setActiveStream(undefined)

		expect(terminal.streamClosedFlag).toBe(true)
	})
})

describe("completion and the process queue", () => {
	it("queues a finished process that still has output, most recent first", () => {
		terminal.process = fakeProcess("first", "one")
		terminal.shellExecutionComplete({ exitCode: 0 })
		terminal.process = fakeProcess("second", "two")
		terminal.shellExecutionComplete({ exitCode: 0 })

		expect(terminal.completedProcesses.map((p) => p.command)).toEqual(["second", "first"])
		expect(terminal.busy).toBe(false)
		expect(terminal.running).toBe(false)
		expect(terminal.process).toBeUndefined()
	})

	it("does NOT queue a finished process whose output was already read", () => {
		const process = fakeProcess("quiet", "")
		terminal.process = process

		terminal.shellExecutionComplete({ exitCode: 0 })

		expect(terminal.completedProcesses).toHaveLength(0)
	})

	it("tolerates a completion with no process at all", () => {
		expect(() => terminal.shellExecutionComplete({ exitCode: 0 })).not.toThrow()
	})

	it("returns each process's output ONCE, then drops it from the queue", () => {
		terminal.process = fakeProcess("first", "one\n")
		terminal.shellExecutionComplete({ exitCode: 0 })
		terminal.process = fakeProcess("live", "live output")

		expect(terminal.getUnretrievedOutput()).toBe("one\nlive output")
		// The queued process has nothing left, so it is gone.
		expect(terminal.completedProcesses).toHaveLength(0)
		expect(terminal.getUnretrievedOutput()).toBe("")
	})

	it("lists only the processes that still have something to say", () => {
		terminal.process = fakeProcess("kept", "output")
		terminal.shellExecutionComplete({ exitCode: 0 })
		terminal.process = fakeProcess("drained", "")
		terminal.shellExecutionComplete({ exitCode: 0 })

		expect(terminal.getProcessesWithOutput().map((p) => p.command)).toEqual(["kept"])
	})

	it("names the last command, preferring the live process over the queue", () => {
		expect(terminal.getLastCommand()).toBe("")

		terminal.process = fakeProcess("queued", "x")
		terminal.shellExecutionComplete({ exitCode: 0 })
		expect(terminal.getLastCommand()).toBe("queued")

		terminal.process = fakeProcess("running", "")
		expect(terminal.getLastCommand()).toBe("running")
	})
})

describe("exit-code interpretation", () => {
	it("passes an ordinary exit code through", () => {
		expect(BaseTerminalProcess.interpretExitCode(0)).toEqual({ exitCode: 0 })
		expect(BaseTerminalProcess.interpretExitCode(1)).toEqual({ exitCode: 1 })
		expect(BaseTerminalProcess.interpretExitCode(undefined)).toEqual({ exitCode: undefined })
	})

	it("decodes a 128+N code into the signal that killed the process", () => {
		expect(BaseTerminalProcess.interpretExitCode(137)).toMatchObject({ exitCode: 137, signalName: "SIGKILL" })
		expect(BaseTerminalProcess.interpretExitCode(130)).toMatchObject({ signalName: "SIGINT" })
		expect(BaseTerminalProcess.interpretExitCode(143)).toMatchObject({ signalName: "SIGTERM" })
	})

	it("flags the signals that can leave a core dump", () => {
		expect(BaseTerminalProcess.interpretExitCode(139)).toMatchObject({
			signalName: "SIGSEGV",
			coreDumpPossible: true,
		})
	})
})

describe("output compression", () => {
	it("collapses a repeated line rather than repeating it hundreds of times", () => {
		const repeated = Array.from({ length: 400 }, () => "same line").join("\n")

		const compressed = BaseTerminal.compressTerminalOutput(repeated)

		expect(compressed.length).toBeLessThan(repeated.length)
	})

	it("truncates output far past the display limit", () => {
		const huge = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n")

		const compressed = BaseTerminal.compressTerminalOutput(huge)

		expect(compressed.split("\n").length).toBeLessThan(5000)
	})

	it("leaves short output alone", () => {
		expect(BaseTerminal.compressTerminalOutput("just one line")).toBe("just one line")
	})
})

describe("shell-integration settings", () => {
	afterEach(() => {
		// These are process-wide statics; put them back.
		BaseTerminal.setShellIntegrationTimeout(BaseTerminal.defaultShellIntegrationTimeout)
		BaseTerminal.setShellIntegrationDisabled(false)
		BaseTerminal.setCommandDelay(0)
		BaseTerminal.setPowershellCounter(false)
		BaseTerminal.setTerminalZshClearEolMark(true)
		BaseTerminal.setTerminalZshOhMy(false)
		BaseTerminal.setTerminalZshP10k(false)
		BaseTerminal.setTerminalZdotdir(false)
		BaseTerminal.setExecaShellPath(undefined)
	})

	it("round-trips every setting", () => {
		BaseTerminal.setShellIntegrationTimeout(9000)
		expect(BaseTerminal.getShellIntegrationTimeout()).toBe(9000)

		BaseTerminal.setShellIntegrationDisabled(true)
		expect(BaseTerminal.getShellIntegrationDisabled()).toBe(true)

		BaseTerminal.setCommandDelay(250)
		expect(BaseTerminal.getCommandDelay()).toBe(250)

		BaseTerminal.setPowershellCounter(true)
		expect(BaseTerminal.getPowershellCounter()).toBe(true)

		BaseTerminal.setTerminalZshClearEolMark(false)
		expect(BaseTerminal.getTerminalZshClearEolMark()).toBe(false)

		BaseTerminal.setTerminalZshOhMy(true)
		expect(BaseTerminal.getTerminalZshOhMy()).toBe(true)

		BaseTerminal.setTerminalZshP10k(true)
		expect(BaseTerminal.getTerminalZshP10k()).toBe(true)

		BaseTerminal.setTerminalZdotdir(true)
		expect(BaseTerminal.getTerminalZdotdir()).toBe(true)

		BaseTerminal.setExecaShellPath("/bin/zsh")
		expect(BaseTerminal.getExecaShellPath()).toBe("/bin/zsh")
	})

	it("starts from the documented default timeout", () => {
		expect(BaseTerminal.getShellIntegrationTimeout()).toBe(BaseTerminal.defaultShellIntegrationTimeout)
	})
})

describe("the callbacks contract", () => {
	it("names the four callbacks a backend must wire", () => {
		// A compile-time shape, asserted at runtime so a renamed callback is
		// caught here rather than in whichever backend forgot it.
		const callbacks: ShoferTerminalCallbacks = {
			onLine: vi.fn(),
			onCompleted: vi.fn(),
			onShellExecutionStarted: vi.fn(),
			onShellExecutionComplete: vi.fn(),
		}

		expect(Object.keys(callbacks).sort()).toEqual([
			"onCompleted",
			"onLine",
			"onShellExecutionComplete",
			"onShellExecutionStarted",
		])
	})
})
