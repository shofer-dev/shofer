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
 * What `execute_command` hands back to the MODEL once the command has ended.
 *
 * The result string is the only thing the model ever sees, so its content is a
 * contract rather than a rendering detail:
 *
 *  - the **exit status is stated in words**, and a non-zero exit is prefixed
 *    with an instruction to inspect the cause. A bare "Exit code: 1" reads as
 *    information; models act on the sentence;
 *  - a signal is reported as a SIGNAL, not as an exit code, because "terminated
 *    by SIGKILL" and "exited 137" call for different next steps;
 *  - an UNDEFINED exit code says so explicitly and asks for the user to be
 *    told, rather than being rendered as a success;
 *  - **large output is PERSISTED and previewed**, not truncated in place. The
 *    model is told the artifact id and the tool that reads it, so the output is
 *    still reachable — a silent truncation loses the tail of a build log
 *    exactly when it is the part that matters.
 */

let cwd: string
let provider: {
	postMessageToWebview: ReturnType<typeof vi.fn>
	getState: ReturnType<typeof vi.fn>
	context: unknown
}

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
		process: processPromise,
		get callbacks() {
			return captured!
		},
		finish: () => resolveProcess!(),
	}
}

function makeTask(overrides: Record<string, unknown> = {}) {
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
		supersedePendingAsk: vi.fn(),
		processQueuedMessages: vi.fn(),
		didToolFailInCurrentTurn: false,
		providerRef: { deref: vi.fn().mockResolvedValue(provider) },
		...overrides,
	} as never
}

const options = (overrides: Partial<ExecuteCommandOptions> = {}): ExecuteCommandOptions => ({
	executionId: "exec-1",
	command: "echo hi",
	terminalShellIntegrationDisabled: true,
	...overrides,
})

/** Run one command to completion with the given output and exit details. */
async function runWith(
	output: string,
	exitDetails: Record<string, unknown> | undefined,
	opts: Partial<ExecuteCommandOptions> = {},
): Promise<string> {
	const term = stubTerminal()
	const run = executeCommandInTerminal(makeTask(), options(opts))
	await vi.waitFor(() => expect(term.callbacks).toBeDefined())

	term.callbacks.onShellExecutionStarted(1234, term.process as never)
	if (output) term.callbacks.onLine(output, term.process as never)
	await term.callbacks.onCompleted(output, term.process as never)
	term.callbacks.onShellExecutionComplete(exitDetails as never, term.process as never)
	term.finish()

	const [, result] = await run
	return String(result)
}

beforeEach(async () => {
	vi.clearAllMocks()
	setHost(createInMemoryHost())
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "shofer-exec-result-"))
	provider = {
		postMessageToWebview: vi.fn(),
		getState: vi.fn().mockResolvedValue({ terminalShellIntegrationDisabled: true }),
		context: {},
	}
})

afterEach(async () => {
	await fs.rm(cwd, { recursive: true, force: true, maxRetries: 3 })
})

describe("the exit status the model reads", () => {
	it("names the working directory and a clean exit", async () => {
		const result = await runWith("done\n", { exitCode: 0 })

		expect(result).toContain(`Command executed in terminal within working directory '${cwd}'`)
		expect(result).toContain("Exit code: 0")
		expect(result).not.toContain("not successful")
	})

	it("tells the model to inspect the cause on a non-zero exit", async () => {
		const result = await runWith("boom\n", { exitCode: 1 })

		expect(result).toContain("Command execution was not successful, inspect the cause and adjust as needed.")
		expect(result).toContain("Exit code: 1")
	})

	it("reports a SIGNAL as a signal rather than as a code", async () => {
		const result = await runWith("", { exitCode: 137, signalName: "SIGKILL" })

		expect(result).toContain("Process terminated by signal SIGKILL")
		expect(result).not.toContain("Exit code: 137")
	})

	it("mentions a possible core dump when the shell reported one", async () => {
		const result = await runWith("", { signalName: "SIGSEGV", coreDumpPossible: true })

		expect(result).toContain("Process terminated by signal SIGSEGV - core dump possible")
	})

	it("says an exit code is missing rather than implying success", async () => {
		const result = await runWith("", { exitCode: undefined })

		expect(result).toContain("Exit code: <undefined, notify user>")
	})

	it("says the same when no exit details arrived at all", async () => {
		// The shell never reported: `onShellExecutionComplete` is simply not
		// called, which is what a terminal without shell integration looks like.
		const term = stubTerminal()
		const run = executeCommandInTerminal(makeTask(), options())
		await vi.waitFor(() => expect(term.callbacks).toBeDefined())

		await term.callbacks.onCompleted("some output\n", term.process as never)
		term.finish()
		const [, result] = await run

		expect(String(result)).toContain("<undefined, notify user>")
	})

	it("carries the command's output alongside the status", async () => {
		expect(await runWith("hello world\n", { exitCode: 0 })).toContain("hello world")
	})
})

describe("output too large to inline", () => {
	beforeEach(() => {
		// A storage path is what turns the interceptor on; without one the tool
		// inlines whatever it has.
		provider.context = { globalStorageUri: { fsPath: cwd } }
		provider.getState = vi
			.fn()
			.mockResolvedValue({ terminalShellIntegrationDisabled: true, terminalOutputPreviewSize: "small" })
	})

	it("persists it, previews it, and names the tool that reads the rest", async () => {
		const huge = `${"x".repeat(50_000)}\n`

		const result = await runWith(huge, { exitCode: 0 })

		expect(result).toContain("persisted. Artifact ID:")
		expect(result).toContain("Preview:")
		expect(result).toContain("Use read_command_output tool to view full output if needed.")
		// Truncating in place would lose the tail of a build log silently.
		expect(result.length).toBeLessThan(huge.length)
	})

	it("states the size in human units", async () => {
		const result = await runWith(`${"y".repeat(50_000)}\n`, { exitCode: 0 })

		expect(result).toMatch(/Output \(\d+(\.\d+)?(B|KB|MB)\)/)
	})

	it("still states the exit status on the persisted path", async () => {
		const result = await runWith(`${"z".repeat(50_000)}\n`, { exitCode: 2 })

		expect(result).toContain("Exit code: 2")
		expect(result).toContain("not successful")
	})

	it("inlines a SMALL output rather than persisting it", async () => {
		const result = await runWith("tiny\n", { exitCode: 0 })

		expect(result).not.toContain("Artifact ID")
		expect(result).toContain("tiny")
	})
})
