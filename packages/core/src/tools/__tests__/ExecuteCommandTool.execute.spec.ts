import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { createInMemoryHost, setHost } from "@shofer/types"

vi.mock("../../terminal/TerminalRegistry.js", async (importOriginal) => ({
	...((await importOriginal()) as Record<string, unknown>),
	TerminalRegistry: { getOrCreateTerminal: vi.fn() },
}))
vi.mock("@shofer/telemetry", () => ({
	TelemetryService: {
		instance: { captureShellIntegrationError: vi.fn() },
		hasInstance: () => false,
	},
}))

import { ExecuteCommandTool, resolveAgentTimeoutMs } from "../ExecuteCommandTool.js"
import { TerminalRegistry } from "../../terminal/TerminalRegistry.js"
import { makeToolCallbacks, toolResults } from "./helpers/fakeEditTask.js"

/**
 * `execute_command`'s own decisions — everything BEFORE the terminal runs, plus
 * the exit-status wording the model reads afterwards.
 *
 * The gate worth pinning is the SANDBOX one: a worktree-scoped task on Linux
 * must fail CLOSED. `getWorktreeSandboxPrefix` throws when the sandbox binary is
 * missing, non-executable or built for the wrong architecture, and the tool
 * turns that into a refusal rather than running the command unsandboxed — which
 * is the only outcome that would silently let a worktree task write outside its
 * worktree.
 */

// The tool checks the working directory really exists before running anything,
// so these tests use a real one rather than an `fs` mock.
let cwd: string

function buildTask(overrides: Record<string, any> = {}) {
	const provider = {
		postMessageToWebview: vi.fn(),
		getState: vi.fn().mockResolvedValue({ terminalShellIntegrationDisabled: false }),
	}
	return {
		cwd,
		workspacePath: cwd,
		taskId: "task-1",
		lastMessageTs: 1234,
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		didRejectTool: false,
		abortSignal: new AbortController().signal,
		terminalProcess: undefined,
		shoferIgnoreController: { validateCommand: vi.fn(() => undefined) },
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		recordToolError: vi.fn(),
		sayAndCreateMissingParamError: vi.fn(async (tool: string, param: string) => `Missing ${param} for ${tool}`),
		supersedePendingAsk: vi.fn(),
		registerBackgroundProcess: vi.fn(),
		unregisterBackgroundProcess: vi.fn(),
		providerRef: { deref: vi.fn().mockResolvedValue(provider) },
		...overrides,
	} as any
}

/** A terminal whose command completes with the given exit details. */
function stubTerminal(exitDetails: unknown, output = "the output") {
	const process: any = Promise.resolve()
	process.continue = vi.fn()
	process.abort = vi.fn()

	const terminal = {
		provider: "execa",
		id: 1,
		initialCwd: cwd,
		getCurrentWorkingDirectory: vi.fn(() => cwd),
		show: vi.fn(),
		runCommand: vi.fn((_command: string, callbacks: any) => {
			setTimeout(() => {
				callbacks.onCompleted(output, process)
				callbacks.onShellExecutionComplete(exitDetails, process)
			}, 0)
			return process
		}),
	}
	vi.mocked(TerminalRegistry.getOrCreateTerminal).mockResolvedValue(terminal as never)
	return terminal
}

beforeEach(async () => {
	vi.clearAllMocks()
	setHost(createInMemoryHost())
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "shofer-exec-command-"))
})

afterEach(async () => {
	await fs.rm(cwd, { recursive: true, force: true })
})

describe("resolveAgentTimeoutMs", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("converts a positive seconds value to milliseconds", () => {
		expect(resolveAgentTimeoutMs(30)).toBe(30_000)
	})

	it("treats absent, zero and negative values as no timeout", () => {
		expect(resolveAgentTimeoutMs(undefined)).toBe(0)
		expect(resolveAgentTimeoutMs(null)).toBe(0)
		expect(resolveAgentTimeoutMs(0)).toBe(0)
		expect(resolveAgentTimeoutMs(-5)).toBe(0)
	})

	it("ignores the model's timeout entirely in the CLI runtime", () => {
		// There, command lifetime is governed by the user's setting alone.
		vi.stubEnv("SHOFER_CLI_RUNTIME", "1")
		expect(resolveAgentTimeoutMs(30)).toBe(0)
	})
})

describe("ExecuteCommandTool.execute — gates before the terminal", () => {
	it("reports a missing command as a usage mistake", async () => {
		const task = buildTask()
		const cbs = makeToolCallbacks()

		await new ExecuteCommandTool().execute({ command: "" } as never, task, cbs)

		expect(task.consecutiveMistakeCount).toBe(1)
		expect(toolResults(cbs)).toContain("Missing command for execute_command")
		expect(cbs.askApproval).not.toHaveBeenCalled()
	})

	it("refuses a command that reaches a .shoferignore'd file", async () => {
		const task = buildTask()
		task.shoferIgnoreController.validateCommand = vi.fn(() => "secret.env")
		const cbs = makeToolCallbacks()

		await new ExecuteCommandTool().execute({ command: "cat secret.env" } as never, task, cbs)

		expect(task.say).toHaveBeenCalledWith("shoferignore_error", "secret.env")
		expect(toolResults(cbs)).toContain("access_denied")
		expect(cbs.askApproval).not.toHaveBeenCalled()
	})

	it("runs nothing when the user rejects the command", async () => {
		const terminal = stubTerminal({ exitCode: 0 })
		const cbs = makeToolCallbacks(false)

		await new ExecuteCommandTool().execute({ command: "echo hi" } as never, buildTask(), cbs)

		expect(terminal.runCommand).not.toHaveBeenCalled()
		expect(cbs.pushToolResult).not.toHaveBeenCalled()
	})

	it("fails CLOSED when a worktree task cannot be sandboxed", async () => {
		if (process.platform !== "linux") return
		const terminal = stubTerminal({ exitCode: 0 })
		// cwd inside `<workspace>/.worktrees/` is what makes this a worktree task;
		// the sandbox binary is not present in a test checkout, so the guard throws.
		const task = buildTask({ cwd: path.join(cwd, ".worktrees/feature"), workspacePath: cwd })
		const cbs = makeToolCallbacks()

		await new ExecuteCommandTool().execute({ command: "rm -rf /" } as never, task, cbs)

		expect(terminal.runCommand).not.toHaveBeenCalled()
		expect(toolResults(cbs)).toContain("Worktree shell sandbox unavailable")
	})

	it("routes an unexpected failure through handleError", async () => {
		const cbs = makeToolCallbacks()
		cbs.askApproval = vi.fn().mockRejectedValue(new Error("approval plumbing broke"))

		await new ExecuteCommandTool().execute({ command: "echo hi" } as never, buildTask(), cbs)

		expect(cbs.handleError).toHaveBeenCalledWith("executing command", expect.any(Error))
	})
})

describe("ExecuteCommandTool.execute — the exit status the model reads", () => {
	async function runWith(exitDetails: unknown): Promise<string> {
		stubTerminal(exitDetails)
		const cbs = makeToolCallbacks()
		await new ExecuteCommandTool().execute({ command: "echo hi" } as never, buildTask(), cbs)
		return toolResults(cbs)
	}

	it("reports a clean exit with the working directory", async () => {
		const result = await runWith({ exitCode: 0 })

		expect(result).toContain(`within working directory '${cwd}'`)
		expect(result).toContain("Exit code: 0")
		expect(result).not.toContain("was not successful")
	})

	it("tells the model plainly that a non-zero exit was a failure", async () => {
		const result = await runWith({ exitCode: 1 })

		expect(result).toContain("Command execution was not successful")
		expect(result).toContain("Exit code: 1")
	})

	it("names the SIGNAL when a command was killed", async () => {
		const result = await runWith({ exitCode: 137, signalName: "SIGKILL" })

		expect(result).toContain("Process terminated by signal SIGKILL")
	})

	it("mentions a possible core dump when the signal produced one", async () => {
		const result = await runWith({ exitCode: 139, signalName: "SIGSEGV", coreDumpPossible: true })

		expect(result).toContain("SIGSEGV - core dump possible")
	})

	it("asks the user to look when the exit code never arrived", async () => {
		// The shell integration reported completion but no code — distinct from
		// the terminal never reporting at all.
		const result = await runWith({ exitCode: undefined })

		expect(result).toContain("<undefined, notify user>")
	})
})
