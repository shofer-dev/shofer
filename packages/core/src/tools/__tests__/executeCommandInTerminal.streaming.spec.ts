import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { createInMemoryHost, setHost, type ShoferTerminalCallbacks } from "@shofer/types"

vi.mock("../../terminal/TerminalRegistry.js", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	TerminalRegistry: { getOrCreateTerminal: vi.fn() },
}))

vi.mock("@shofer/telemetry", () => ({
	TelemetryService: { instance: { captureShellIntegrationError: vi.fn() }, hasInstance: () => false },
}))

import { executeCommandInTerminal, type ExecuteCommandOptions } from "../ExecuteCommandTool.js"
import { TerminalRegistry } from "../../terminal/TerminalRegistry.js"

/**
 * `executeCommandInTerminal` — the streaming half of `execute_command`: what
 * reaches the webview while a command runs, what reaches the MODEL when it
 * finishes, and the two independent timeouts.
 *
 * The dual timeout is the design worth pinning, because the two mean opposite
 * things. The AGENT timeout backgrounds a command that is still running, so the
 * turn can continue and the output be collected later; the USER timeout KILLS
 * it. Both timers run at once — the user's stays armed as a safety net after
 * the agent's has moved the command to the background — and only one of them
 * ends the command.
 *
 * The other invariant is the status vocabulary the webview renders:
 * `started` → `output`* → `exited`, or `terminated` when the user pressed Kill.
 * Reporting a natural exit as `terminated` puts a "Killed" badge on a command
 * that finished normally.
 */

let cwd: string
let provider: { postMessageToWebview: ReturnType<typeof vi.fn>; getState: ReturnType<typeof vi.fn>; context: unknown }

/** The terminal the registry hands back, with the callbacks the tool passed it. */
function stubTerminal() {
	let captured: ShoferTerminalCallbacks | undefined
	let resolveProcess: (() => void) | undefined
	const processPromise = new Promise<void>((resolve) => {
		resolveProcess = resolve
	}) as Promise<void> & { continue: () => void; abort: () => void }
	processPromise.continue = vi.fn()
	processPromise.abort = vi.fn()

	const terminal = {
		provider: "execa" as const,
		id: 1,
		initialCwd: cwd,
		getCurrentWorkingDirectory: () => cwd,
		show: vi.fn(),
		runCommand: vi.fn((_command: string, callbacks: ShoferTerminalCallbacks) => {
			captured = callbacks
			return processPromise
		}),
	}
	vi.mocked(TerminalRegistry.getOrCreateTerminal).mockResolvedValue(terminal as never)

	return {
		terminal,
		process: processPromise,
		get callbacks() {
			return captured!
		},
		finish: () => resolveProcess!(),
	}
}

function makeTask(overrides: Record<string, any> = {}) {
	return {
		cwd,
		workspacePath: cwd,
		taskId: "task-1",
		userTerminatedCommand: false,
		abortSignal: new AbortController().signal,
		terminalProcess: undefined,
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		registerBackgroundProcess: vi.fn(),
		unregisterBackgroundProcess: vi.fn(),
		// Backgrounding a command withdraws the "keep watching?" ask it raised.
		supersedePendingAsk: vi.fn(),
		processQueuedMessages: vi.fn(),
		didToolFailInCurrentTurn: false,
		providerRef: { deref: vi.fn().mockResolvedValue(provider) },
		...overrides,
	} as any
}

const options = (overrides: Partial<ExecuteCommandOptions> = {}): ExecuteCommandOptions => ({
	executionId: "exec-1",
	command: "echo hi",
	terminalShellIntegrationDisabled: true,
	...overrides,
})

/** The `commandExecutionStatus` values posted to the webview, in order. */
function statuses(): string[] {
	return provider.postMessageToWebview.mock.calls
		.filter((c: unknown[]) => (c[0] as { type: string }).type === "commandExecutionStatus")
		.map((c: unknown[]) => JSON.parse((c[0] as { text: string }).text).status)
}

beforeEach(async () => {
	vi.clearAllMocks()
	setHost(createInMemoryHost())
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "shofer-exec-stream-"))
	provider = {
		postMessageToWebview: vi.fn(),
		getState: vi.fn().mockResolvedValue({ terminalShellIntegrationDisabled: true }),
		context: {},
	}
})

afterEach(async () => {
	await fs.rm(cwd, { recursive: true, force: true, maxRetries: 3 })
})

describe("what the webview is told", () => {
	it("posts started → output → exited for an ordinary command", async () => {
		const term = stubTerminal()
		const run = executeCommandInTerminal(makeTask(), options())
		await vi.waitFor(() => expect(term.callbacks).toBeDefined())

		term.callbacks.onShellExecutionStarted(1234, term.process as never)
		term.callbacks.onLine("some output\n", term.process as never)
		await term.callbacks.onCompleted("some output\n", term.process as never)
		term.callbacks.onShellExecutionComplete({ exitCode: 0 }, term.process as never)
		term.finish()
		await run

		expect(statuses()).toEqual(["started", "output", "exited"])
	})

	it("reports the user's Kill as TERMINATED, and consumes the flag", async () => {
		const term = stubTerminal()
		const task = makeTask()
		const run = executeCommandInTerminal(task, options())
		await vi.waitFor(() => expect(term.callbacks).toBeDefined())

		task.userTerminatedCommand = true
		await term.callbacks.onCompleted("partial\n", term.process as never)
		term.callbacks.onShellExecutionComplete({ exitCode: 130 }, term.process as never)
		term.finish()
		await run

		expect(statuses()).toContain("terminated")
		// Consumed, so the NEXT command's natural exit is not mislabelled.
		expect(task.userTerminatedCommand).toBe(false)
	})

	it("clears a stale kill flag when a fresh command starts", async () => {
		const term = stubTerminal()
		const task = makeTask({ userTerminatedCommand: true })
		const run = executeCommandInTerminal(task, options())
		await vi.waitFor(() => expect(term.callbacks).toBeDefined())

		term.callbacks.onShellExecutionStarted(1, term.process as never)

		expect(task.userTerminatedCommand).toBe(false)
		term.finish()
		await run
	})

	it("streams the output as a PARTIAL say, then finalizes it", async () => {
		const term = stubTerminal()
		const task = makeTask()
		const run = executeCommandInTerminal(task, options())
		await vi.waitFor(() => expect(term.callbacks).toBeDefined())

		term.callbacks.onLine("line one\n", term.process as never)
		await term.callbacks.onCompleted("line one\n", term.process as never)
		term.finish()
		await run

		const outputs = task.say.mock.calls.filter((c: unknown[]) => c[0] === "command_output")
		expect(outputs.length).toBeGreaterThan(0)
		// The last one is the finalized (non-partial) row.
		expect(outputs.at(-1)![3]).toBe(false)
	})

	it("drops the process from the background registry once it completes", async () => {
		const term = stubTerminal()
		const task = makeTask()
		const run = executeCommandInTerminal(task, options())
		await vi.waitFor(() => expect(term.callbacks).toBeDefined())

		await term.callbacks.onCompleted("done\n", term.process as never)
		term.callbacks.onShellExecutionComplete({ exitCode: 0 }, term.process as never)
		term.finish()
		await run

		expect(task.unregisterBackgroundProcess).toHaveBeenCalledWith("exec-1")
	})
})

describe("the two timeouts", () => {
	it("BACKGROUNDS the command when the agent's timeout fires, leaving it running", async () => {
		const term = stubTerminal()
		const task = makeTask()

		const [rejected, result] = await executeCommandInTerminal(task, options({ agentTimeout: 10 }))

		expect(rejected).toBe(false)
		// The command keeps running, so the turn is told it is still going.
		expect(String(result)).toMatch(/still running|background/i)
		expect(term.process.continue).toHaveBeenCalled()
		// It is handed to the registry so Stop/Kill can still reach it.
		expect(task.registerBackgroundProcess).toHaveBeenCalledWith("exec-1", term.process)
	})

	it("KILLS the command when the user's timeout fires, and says not to retry", async () => {
		const term = stubTerminal()
		const task = makeTask()
		task.terminalProcess = term.process

		const [rejected, result] = await executeCommandInTerminal(task, options({ commandExecutionTimeout: 10 }))

		expect(rejected).toBe(false)
		expect(String(result)).toMatch(/Do not try to re-run the command/)
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(statuses()).toContain("timeout")
	})

	it("unwinds immediately when the user presses Stop", async () => {
		stubTerminal()
		const controller = new AbortController()
		const task = makeTask({ abortSignal: controller.signal })

		const pending = executeCommandInTerminal(task, options())
		controller.abort()
		const [rejected, result] = await pending

		expect(rejected).toBe(false)
		expect(String(result)).toMatch(/aborted by the user/i)
	})

	it("refuses to run in a directory that does not exist", async () => {
		stubTerminal()

		const [, result] = await executeCommandInTerminal(makeTask(), options({ customCwd: "/definitely/not/here" }))

		expect(String(result)).toMatch(/does not exist/)
	})
})

describe("interactive output", () => {
	it("asks the user once whether to keep watching, and continues on a reply", async () => {
		const term = stubTerminal()
		const task = makeTask({
			ask: vi.fn().mockResolvedValue({ response: "messageResponse", text: "carry on" }),
		})
		const run = executeCommandInTerminal(task, options())
		await vi.waitFor(() => expect(term.callbacks).toBeDefined())

		term.callbacks.onLine("first\n", term.process as never)
		await vi.waitFor(() => expect(task.ask).toHaveBeenCalledWith("command_output", ""))
		// A second line must NOT raise a second ask.
		term.callbacks.onLine("second\n", term.process as never)

		term.finish()
		const [rejected, result] = await run

		expect(task.ask).toHaveBeenCalledTimes(1)
		expect(rejected).toBe(true)
		expect(String(result)).toContain("carry on")
	})
})
