/**
 * Unit tests for the `run` entry point (`src/commands/cli/run.ts`) — the
 * function every bare `shofer …` invocation lands in.
 *
 * `run()` is mostly a long validation gauntlet followed by one of three
 * launches (TUI / stdin-stream / one-shot task). Everything expensive behind it
 * is faked: the extension host, the JSON event emitter, the stdin stream
 * driver, the settings and task-history stores, and — for the TUI branch — ink
 * and the App component. No LLM provider, no network, no real workspace state.
 *
 * Two harness details are load-bearing and easy to misread:
 *
 * - `process.exit` is stubbed to THROW (`ExitSignal`), because the real one
 *   never returns and the code after each `process.exit(1)` assumes so. The
 *   success path's `process.exit(0)` sits INSIDE `run()`'s own try/catch, so a
 *   thrown signal there is caught and followed by a second `process.exit(1)`.
 *   Assertions therefore read the FIRST recorded exit code, never the last.
 * - The runtime-handler tests stub `process.on`/`process.off` instead of really
 *   registering, so a fake `uncaughtException` never reaches Node's or
 *   vitest's own handlers.
 */

import type { FlagOptions } from "@/types/index.js"

import { run } from "../run.js"

class ExitSignal extends Error {
	constructor(readonly code: number | undefined) {
		super(`process.exit(${code})`)
		this.name = "ExitSignal"
	}
}

const hostState = vi.hoisted(() => ({
	/** Every host the run under test constructed, newest last. */
	instances: [] as Array<Record<string, unknown>>,
	/** What `runTask` / `resumeTask` should do (default: resolve immediately). */
	taskBehaviour: "resolve" as "resolve" | "hang" | "throw",
	hasActiveTask: true,
	isWaitingForInput: true,
}))

const emitterState = vi.hoisted(() => ({ instances: [] as Array<Record<string, unknown>> }))
const runStdinStreamMode = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}))
const loadSettings = vi.hoisted(() => vi.fn(async () => ({}) as Record<string, unknown>))
const readWorkspaceTaskSessions = vi.hoisted(() => vi.fn(async () => [] as unknown[]))
const resolveWorkspaceResumeSessionId = vi.hoisted(() => vi.fn(() => "resolved-session-id"))
const inkRender = vi.hoisted(() => vi.fn())

vi.mock("@shofer/vscode-shim", () => ({ setLogger: vi.fn() }))

vi.mock("@/agent/index.js", () => {
	class ExtensionHost {
		options: unknown
		listeners = new Map<string, Array<(...args: unknown[]) => void>>()
		activate = vi.fn(async () => {})
		dispose = vi.fn(async () => {})
		setAskDispatcherEnabled = vi.fn()
		sendToExtension = vi.fn()
		isWaitingForInput = vi.fn(() => hostState.isWaitingForInput)
		client = { hasActiveTask: vi.fn(() => hostState.hasActiveTask) }
		api = {
			on: (event: string, listener: (...args: unknown[]) => void) => {
				const bucket = this.listeners.get(event) ?? []
				bucket.push(listener)
				this.listeners.set(event, bucket)
			},
			off: vi.fn(),
		}
		runTask = vi.fn(() => this.task())
		resumeTask = vi.fn(() => this.task())

		constructor(options: unknown) {
			this.options = options
			hostState.instances.push(this as unknown as Record<string, unknown>)
		}

		private task(): Promise<void> {
			if (hostState.taskBehaviour === "hang") return new Promise<void>(() => {})
			if (hostState.taskBehaviour === "throw") return Promise.reject(new Error("task blew up"))
			return Promise.resolve()
		}

		emit(event: string, ...args: unknown[]): void {
			for (const listener of this.listeners.get(event) ?? []) listener(...args)
		}
	}

	return { ExtensionHost, unattendedApprovalSeed: () => ({ unattended: true }) }
})

vi.mock("@/agent/json-event-emitter.js", () => {
	class JsonEventEmitter {
		attachToClient = vi.fn()
		detach = vi.fn()
		flush = vi.fn(async () => {})

		constructor(readonly options: unknown) {
			emitterState.instances.push(this as unknown as Record<string, unknown>)
		}
	}

	return { JsonEventEmitter }
})

vi.mock("../stdin-stream.js", () => ({ runStdinStreamMode }))
vi.mock("@/lib/storage/index.js", () => ({ loadSettings }))
vi.mock("@/lib/task-history/index.js", () => ({ readWorkspaceTaskSessions, resolveWorkspaceResumeSessionId }))
vi.mock("ink", () => ({ render: inkRender }))
vi.mock("../../../ui/App.js", () => ({ App: () => null }))

const UUID = "11111111-2222-4333-8444-555555555555"
const OTHER_UUID = "99999999-2222-4333-8444-555555555555"

function flags(overrides: Partial<FlagOptions> = {}): FlagOptions {
	return {
		continue: false,
		print: false,
		stdinPromptStream: false,
		signalOnlyExit: false,
		debug: false,
		requireApproval: false,
		exitOnError: false,
		ephemeral: false,
		oneshot: false,
		extension: "/tmp",
		apiKey: "test-key",
		model: "test-model",
		...overrides,
	}
}

/** Narrow alias so the spy keeps `process.exit`'s own signature. */
const _spyOnExit = () => vi.spyOn(process, "exit")
let exitSpy: ReturnType<typeof _spyOnExit>
let errorLines: string[]

/** Codes handed to `process.exit`, in call order. */
function exitCodes(): Array<number | undefined> {
	return exitSpy.mock.calls.map((call) => call[0] as number | undefined)
}

/** The most recently constructed fake extension host. */
function lastHost(): Record<string, unknown> {
	return hostState.instances.at(-1)!
}

/** Run and assert it terminated the process; returns the FIRST exit code. */
async function runExpectingExit(prompt: string | undefined, options: FlagOptions): Promise<number | undefined> {
	await expect(run(prompt, options)).rejects.toBeInstanceOf(ExitSignal)
	return exitCodes()[0]
}

describe("run", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		hostState.instances = []
		hostState.taskBehaviour = "resolve"
		hostState.hasActiveTask = true
		hostState.isWaitingForInput = true
		emitterState.instances = []
		loadSettings.mockResolvedValue({})
		readWorkspaceTaskSessions.mockResolvedValue([])
		resolveWorkspaceResumeSessionId.mockReturnValue("resolved-session-id")

		errorLines = []
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errorLines.push(args.map(String).join(" "))
		})
		vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			errorLines.push(args.map(String).join(" "))
		})
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(process.stdout, "write").mockImplementation(((_chunk: unknown, cb?: unknown) => {
			if (typeof cb === "function") (cb as (e?: Error | null) => void)(null)
			return true
		}) as never)
		exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new ExitSignal(code)
		}) as never)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	const stderr = () => errorLines.join("\n")

	describe("prompt sources", () => {
		it("refuses a --prompt-file that does not exist", async () => {
			const missing = "/tmp/definitely-not-here-4f3a/prompt.md"
			expect(await runExpectingExit(undefined, flags({ promptFile: missing }))).toBe(1)
			expect(stderr()).toContain(`Prompt file does not exist: ${missing}`)
		})

		it("reads the prompt out of --prompt-file", async () => {
			const fs = await import("fs")
			const os = await import("os")
			const path = await import("path")
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-prompt-"))
			const file = path.join(dir, "prompt.md")
			fs.writeFileSync(file, "from the file")

			try {
				await runExpectingExit(undefined, flags({ promptFile: file, print: true }))
				expect(lastHost().runTask).toHaveBeenCalledWith("from the file", undefined)
			} finally {
				fs.rmSync(dir, { recursive: true, force: true })
			}
		})
	})

	describe("session-id validation", () => {
		it("rejects an empty --create-with-session-id", async () => {
			expect(await runExpectingExit("hi", flags({ createWithSessionId: "   " }))).toBe(1)
			expect(stderr()).toContain("--create-with-session-id requires a non-empty session id")
		})

		it("rejects an empty --session-id", async () => {
			expect(await runExpectingExit(undefined, flags({ sessionId: "" }))).toBe(1)
			expect(stderr()).toContain("--session-id requires a non-empty session id")
		})

		it("rejects a --create-with-session-id that is not a UUID", async () => {
			expect(await runExpectingExit("hi", flags({ createWithSessionId: "abc" }))).toBe(1)
			expect(stderr()).toContain("--create-with-session-id must be a valid UUID session id")
		})

		it("rejects a --session-id that is not a UUID", async () => {
			expect(await runExpectingExit(undefined, flags({ sessionId: "abc" }))).toBe(1)
			expect(stderr()).toContain("--session-id must be a valid UUID session id")
		})

		it("refuses --create-with-session-id together with --session-id", async () => {
			expect(await runExpectingExit(undefined, flags({ createWithSessionId: UUID, sessionId: OTHER_UUID }))).toBe(
				1,
			)
			expect(stderr()).toContain("cannot use --create-with-session-id with --session-id/--continue")
		})

		it("refuses --session-id together with --continue", async () => {
			expect(await runExpectingExit(undefined, flags({ sessionId: UUID, continue: true }))).toBe(1)
			expect(stderr()).toContain("cannot use --session-id with --continue")
		})

		it("refuses a prompt alongside a resume request", async () => {
			expect(await runExpectingExit("hello", flags({ continue: true }))).toBe(1)
			expect(stderr()).toContain("cannot use prompt or --prompt-file with --session-id/--continue")
		})
	})

	describe("option validation", () => {
		it("refuses a non-integer consecutive mistake limit", async () => {
			expect(await runExpectingExit("hi", flags({ consecutiveMistakeLimit: 1.5 }))).toBe(1)
			expect(stderr()).toContain("Invalid consecutive mistake limit: 1.5")
		})

		it("refuses a negative consecutive mistake limit", async () => {
			expect(await runExpectingExit("hi", flags({ consecutiveMistakeLimit: -1 }))).toBe(1)
			expect(stderr()).toContain("must be a non-negative integer")
		})

		it("takes the consecutive mistake limit from settings when no flag is given", async () => {
			loadSettings.mockResolvedValue({ consecutiveMistakeLimit: 3 })
			await runExpectingExit("hi", flags())
			expect(lastHost().options).toMatchObject({ consecutiveMistakeLimit: 3 })
		})

		it("warns and ignores an invalid --terminal-shell", async () => {
			await runExpectingExit("hi", flags({ terminalShell: "relative/sh" }))
			expect(stderr()).toContain('ignoring --terminal-shell "relative/sh"')
			expect(lastHost().options).toMatchObject({ terminalShell: undefined })
		})

		it("keeps a valid --terminal-shell", async () => {
			await runExpectingExit("hi", flags({ terminalShell: "/bin/sh" }))
			expect(lastHost().options).toMatchObject({ terminalShell: "/bin/sh" })
		})

		it("refuses to start with no model configured anywhere", async () => {
			expect(await runExpectingExit("hi", flags({ model: undefined }))).toBe(1)
			expect(stderr()).toContain("No model configured for the openrouter provider")
		})

		it("takes the model, mode and reasoning effort from settings", async () => {
			loadSettings.mockResolvedValue({ model: "settings-model", mode: "architect", reasoningEffort: "high" })
			await runExpectingExit("hi", flags({ model: undefined }))
			expect(lastHost().options).toMatchObject({
				model: "settings-model",
				mode: "architect",
				reasoningEffort: "high",
			})
		})

		it("drops the reasoning effort when it is 'unspecified'", async () => {
			await runExpectingExit("hi", flags({ reasoningEffort: "unspecified" }))
			expect(lastHost().options).toMatchObject({ reasoningEffort: undefined })
		})

		it("refuses an unsupported provider", async () => {
			expect(await runExpectingExit("hi", flags({ provider: "deepseek" as never }))).toBe(1)
			expect(stderr()).toContain("Invalid provider: deepseek")
		})

		it("refuses an invalid reasoning effort", async () => {
			expect(await runExpectingExit("hi", flags({ reasoningEffort: "colossal" as never }))).toBe(1)
			expect(stderr()).toContain("Invalid reasoning effort: colossal")
		})

		it("refuses to start with no api key for a real provider", async () => {
			const previous = process.env.OPENROUTER_API_KEY
			delete process.env.OPENROUTER_API_KEY
			try {
				expect(await runExpectingExit("hi", flags({ apiKey: undefined }))).toBe(1)
				expect(stderr()).toContain("No API key provided")
				expect(stderr()).toContain("OPENROUTER_API_KEY")
			} finally {
				if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous
			}
		})

		it("falls back to the provider's environment variable for the api key", async () => {
			const previous = process.env.OPENROUTER_API_KEY
			process.env.OPENROUTER_API_KEY = "from-env"
			try {
				await runExpectingExit("hi", flags({ apiKey: undefined }))
				expect(lastHost().options).toMatchObject({ apiKey: "from-env" })
			} finally {
				if (previous === undefined) delete process.env.OPENROUTER_API_KEY
				else process.env.OPENROUTER_API_KEY = previous
			}
		})

		it("needs no api key for the mock provider", async () => {
			const previous = process.env.MOCK_API_KEY
			delete process.env.MOCK_API_KEY
			try {
				await runExpectingExit("hi", flags({ apiKey: undefined, provider: "mock" }))
				expect(exitCodes()[0]).toBe(0)
			} finally {
				if (previous !== undefined) process.env.MOCK_API_KEY = previous
			}
		})

		it("refuses a workspace path that does not exist", async () => {
			expect(await runExpectingExit("hi", flags({ workspace: "/tmp/nope-4f3a-nope" }))).toBe(1)
			expect(stderr()).toContain("Workspace path does not exist")
		})

		it("resolves --workspace against the cwd", async () => {
			await runExpectingExit("hi", flags({ workspace: "." }))
			expect(lastHost().options).toMatchObject({ workspacePath: process.cwd() })
		})

		it("refuses an invalid --output-format", async () => {
			expect(await runExpectingExit("hi", flags({ print: true, outputFormat: "yaml" as never }))).toBe(1)
			expect(stderr()).toContain("Invalid output format: yaml")
		})
	})

	describe("stdin-stream flag coupling", () => {
		it("requires --print for --stdin-prompt-stream", async () => {
			expect(await runExpectingExit(undefined, flags({ stdinPromptStream: true }))).toBe(1)
			expect(stderr()).toContain("--stdin-prompt-stream requires --print mode")
		})

		it("requires --stdin-prompt-stream for --signal-only-exit", async () => {
			expect(await runExpectingExit(undefined, flags({ print: true, signalOnlyExit: true }))).toBe(1)
			expect(stderr()).toContain("--signal-only-exit requires --stdin-prompt-stream")
		})

		it("requires stream-json output for --stdin-prompt-stream", async () => {
			const options = flags({ print: true, stdinPromptStream: true, outputFormat: "json" })
			expect(await runExpectingExit(undefined, options)).toBe(1)
			expect(stderr()).toContain("--stdin-prompt-stream requires --output-format=stream-json")
		})

		it("refuses a positional prompt with --stdin-prompt-stream", async () => {
			const options = flags({ print: true, stdinPromptStream: true, outputFormat: "stream-json" })
			expect(await runExpectingExit("hello", options)).toBe(1)
			expect(stderr()).toContain("cannot use positional prompt or --prompt-file with --stdin-prompt-stream")
		})

		it("refuses --create-with-session-id with --stdin-prompt-stream", async () => {
			const options = flags({
				print: true,
				stdinPromptStream: true,
				outputFormat: "stream-json",
				createWithSessionId: UUID,
			})
			expect(await runExpectingExit(undefined, options)).toBe(1)
			expect(stderr()).toContain("--create-with-session-id is not supported with --stdin-prompt-stream")
		})

		it("refuses --stdin-prompt-stream when stdin is a TTY", async () => {
			const previous = process.stdin.isTTY
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
			try {
				const options = flags({ print: true, stdinPromptStream: true, outputFormat: "stream-json" })
				expect(await runExpectingExit(undefined, options)).toBe(1)
				expect(stderr()).toContain("--stdin-prompt-stream requires piped stdin")
			} finally {
				Object.defineProperty(process.stdin, "isTTY", { value: previous, configurable: true })
			}
		})
	})

	describe("resume resolution", () => {
		it("reports a resume that cannot be resolved", async () => {
			resolveWorkspaceResumeSessionId.mockImplementation(() => {
				throw new Error("no sessions in this workspace")
			})
			expect(await runExpectingExit(undefined, flags({ continue: true }))).toBe(1)
			expect(stderr()).toContain("[CLI] Error: no sessions in this workspace")
		})

		it("stringifies a non-Error resume failure", async () => {
			resolveWorkspaceResumeSessionId.mockImplementation(() => {
				throw "plain string failure"
			})
			expect(await runExpectingExit(undefined, flags({ continue: true }))).toBe(1)
			expect(stderr()).toContain("[CLI] Error: plain string failure")
		})

		it("resumes the resolved session id", async () => {
			await runExpectingExit(undefined, flags({ sessionId: UUID }))
			expect(readWorkspaceTaskSessions).toHaveBeenCalledWith(process.cwd())
			expect(resolveWorkspaceResumeSessionId).toHaveBeenCalledWith([], UUID)
			expect(lastHost().resumeTask).toHaveBeenCalledWith("resolved-session-id")
		})
	})

	describe("non-interactive prompt requirement", () => {
		it("insists on a prompt under --print", async () => {
			expect(await runExpectingExit(undefined, flags({ print: true }))).toBe(1)
			expect(stderr()).toContain("Usage: shofer --print [options] <prompt>")
		})

		it("insists on a prompt when there is no TTY", async () => {
			expect(await runExpectingExit(undefined, flags())).toBe(1)
			expect(stderr()).toContain("prompt is required in non-interactive mode")
		})

		it("warns that the TUI is unavailable when falling back to print mode", async () => {
			await runExpectingExit("hi", flags())
			expect(stderr()).toContain("TUI disabled (no TTY support), falling back to print mode")
		})
	})

	describe("one-shot task launch", () => {
		it("activates the host, runs the task and exits 0", async () => {
			await runExpectingExit("do the thing", flags({ print: true }))

			const host = lastHost()
			expect(host.activate).toHaveBeenCalledTimes(1)
			expect(host.runTask).toHaveBeenCalledWith("do the thing", undefined)
			expect(host.dispose).toHaveBeenCalledTimes(1)
			expect(exitCodes()[0]).toBe(0)
		})

		it("passes --create-with-session-id through as the new task id", async () => {
			await runExpectingExit("do the thing", flags({ print: true, createWithSessionId: UUID }))
			expect(lastHost().runTask).toHaveBeenCalledWith("do the thing", UUID)
		})

		it("seeds unattended approvals unless --require-approval is given", async () => {
			await runExpectingExit("hi", flags({ print: true }))
			expect(lastHost().options).toMatchObject({ nonInteractive: true, approvalSeed: { unattended: true } })
		})

		it("leaves the built-in approval seed alone under --require-approval", async () => {
			await runExpectingExit("hi", flags({ print: true, requireApproval: true }))
			expect(lastHost().options).toMatchObject({ nonInteractive: false, approvalSeed: undefined })
		})

		it("honours the legacy dangerouslySkipPermissions setting", async () => {
			loadSettings.mockResolvedValue({ dangerouslySkipPermissions: false })
			await runExpectingExit("hi", flags({ print: true }))
			expect(lastHost().options).toMatchObject({ nonInteractive: false })
		})

		it("treats --print, --oneshot and the oneshot setting as exit-on-complete", async () => {
			await runExpectingExit("hi", flags({ print: true }))
			expect(lastHost().options).toMatchObject({ exitOnComplete: true })

			loadSettings.mockResolvedValue({ oneshot: true })
			await runExpectingExit("hi", flags())
			expect(lastHost().options).toMatchObject({ exitOnComplete: true })
		})

		it("builds no JSON emitter for text output", async () => {
			await runExpectingExit("hi", flags({ print: true }))
			expect(emitterState.instances).toHaveLength(0)
			expect(lastHost().options).toMatchObject({ disableOutput: false })
		})

		it("builds a JSON emitter and silences ordinary output for --output-format json", async () => {
			await runExpectingExit("hi", flags({ print: true, outputFormat: "json" }))

			expect(emitterState.instances).toHaveLength(1)
			expect(emitterState.instances[0]!.options).toMatchObject({ mode: "json" })
			expect(emitterState.instances[0]!.attachToClient).toHaveBeenCalledTimes(1)
			expect(emitterState.instances[0]!.flush).toHaveBeenCalled()
			expect(lastHost().options).toMatchObject({ disableOutput: true })
		})

		it("skips the stdout flush when stdout is no longer writable", async () => {
			const original = Object.getOwnPropertyDescriptor(process.stdout, "writable")
			Object.defineProperty(process.stdout, "writable", { value: false, configurable: true })

			try {
				await runExpectingExit("hi", flags({ print: true }))
				expect(exitCodes()[0]).toBe(0)
				expect(process.stdout.write).not.toHaveBeenCalled()
			} finally {
				if (original) Object.defineProperty(process.stdout, "writable", original)
				else delete (process.stdout as unknown as Record<string, unknown>).writable
			}
		})

		it("shuts down anyway when the stdout flush itself fails", async () => {
			vi.mocked(process.stdout.write).mockImplementation(((_chunk: unknown, cb?: unknown) => {
				if (typeof cb === "function") (cb as (e?: Error | null) => void)(new Error("EPIPE"))
				return true
			}) as never)

			await runExpectingExit("hi", flags({ print: true }))

			expect(exitCodes()[0]).toBe(0)
		})

		it("reports a task failure and exits 1", async () => {
			hostState.taskBehaviour = "throw"
			expect(await runExpectingExit("hi", flags({ print: true }))).toBe(1)
			expect(stderr()).toContain("[CLI] Error: task blew up")
			expect(lastHost().dispose).toHaveBeenCalled()
		})

		it("emits a task failure as a JSON error event under json output", async () => {
			hostState.taskBehaviour = "throw"
			const writes: string[] = []
			vi.mocked(process.stdout.write).mockImplementation(((chunk: unknown, cb?: unknown) => {
				writes.push(String(chunk))
				if (typeof cb === "function") (cb as (e?: Error | null) => void)(null)
				return true
			}) as never)

			await runExpectingExit("hi", flags({ print: true, outputFormat: "json" }))

			const events = writes.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))
			expect(events[0]).toMatchObject({ type: "error", content: "task blew up" })
		})
	})

	describe("stdin stream launch", () => {
		const streamFlags = (overrides: Partial<FlagOptions> = {}) =>
			flags({ print: true, stdinPromptStream: true, outputFormat: "stream-json", ...overrides })

		it("hands the host and emitter to the stdin stream driver", async () => {
			await runExpectingExit(undefined, streamFlags())

			expect(runStdinStreamMode).toHaveBeenCalledTimes(1)
			const args = runStdinStreamMode.mock.calls[0]![0] as {
				host: unknown
				jsonEmitter: unknown
				setStreamRequestId: (id: string) => void
			}
			expect(args.host).toBe(lastHost())
			expect(args.jsonEmitter).toBe(emitterState.instances[0])
			expect(() => args.setStreamRequestId("req-1")).not.toThrow()
			expect(exitCodes()[0]).toBe(0)
		})

		it("bootstraps a resume before handing over to the stream driver", async () => {
			await runExpectingExit(undefined, streamFlags({ continue: true }))

			const host = lastHost()
			expect(host.setAskDispatcherEnabled).toHaveBeenCalledWith(false)
			expect(host.sendToExtension).toHaveBeenCalledWith({
				type: "showTaskWithId",
				text: "resolved-session-id",
			})
			expect(runStdinStreamMode).toHaveBeenCalledTimes(1)

			// The TaskStarted listener is idempotent once the wait has settled.
			expect(() =>
				(host as unknown as { emit: (e: string, id: string) => void }).emit("taskStarted", "t"),
			).not.toThrow()
		})

		it("gives up waiting for the resumed task after the fallback timeout", async () => {
			hostState.hasActiveTask = false
			vi.useFakeTimers()

			const pending = run(undefined, streamFlags({ continue: true }))
			const assertion = expect(pending).rejects.toBeInstanceOf(ExitSignal)
			await vi.advanceTimersByTimeAsync(2_500)
			await assertion

			expect(runStdinStreamMode).toHaveBeenCalledTimes(1)
			expect(exitCodes()[0]).toBe(0)
		})

		it("parks instead of exiting under --signal-only-exit", async () => {
			vi.useFakeTimers()
			let settled = false
			void run(undefined, streamFlags({ signalOnlyExit: true })).finally(() => {
				settled = true
			})

			await vi.advanceTimersByTimeAsync(10)

			expect(runStdinStreamMode).toHaveBeenCalledTimes(1)
			expect(lastHost().dispose).toHaveBeenCalledTimes(1)
			expect(settled).toBe(false)
			expect(exitSpy).not.toHaveBeenCalled()
			// The keep-alive interval is what holds the event loop open while parked.
			expect(vi.getTimerCount()).toBeGreaterThan(0)
		})

		it("parks after a failure too under --signal-only-exit", async () => {
			hostState.taskBehaviour = "throw"
			runStdinStreamMode.mockRejectedValueOnce(new Error("stream driver died"))
			vi.useFakeTimers()
			let settled = false
			void run(undefined, streamFlags({ signalOnlyExit: true })).finally(() => {
				settled = true
			})

			await vi.advanceTimersByTimeAsync(10)

			expect(settled).toBe(false)
			expect(exitSpy).not.toHaveBeenCalled()
		})
	})

	describe("TUI launch", () => {
		let previousStdin: unknown
		let previousStdout: unknown

		beforeEach(() => {
			previousStdin = process.stdin.isTTY
			previousStdout = process.stdout.isTTY
			Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
		})

		afterEach(() => {
			Object.defineProperty(process.stdin, "isTTY", { value: previousStdin, configurable: true })
			Object.defineProperty(process.stdout, "isTTY", { value: previousStdout, configurable: true })
		})

		it("renders the App with the host options and never exits", async () => {
			await expect(run("hello", flags())).resolves.toBeUndefined()

			expect(inkRender).toHaveBeenCalledTimes(1)
			const [element, renderOptions] = inkRender.mock.calls[0] as [{ props: Record<string, unknown> }, unknown]
			expect(element.props).toMatchObject({
				initialPrompt: "hello",
				model: "test-model",
				continueSession: false,
			})
			expect(renderOptions).toEqual({ exitOnCtrlC: false })
			expect(exitSpy).not.toHaveBeenCalled()
		})

		it("constructs an extension host through the injected factory", async () => {
			await run("hello", flags())
			const [element] = inkRender.mock.calls[0] as [{ props: Record<string, unknown> }]
			const factory = element.props.createExtensionHost as (opts: unknown) => unknown
			expect(factory({ mode: "code" })).toBe(lastHost())
		})

		it("passes a resumed session id into the TUI", async () => {
			await run(undefined, flags({ sessionId: UUID }))
			const [element] = inkRender.mock.calls[0] as [{ props: Record<string, unknown> }]
			expect(element.props.initialSessionId).toBe("resolved-session-id")
		})

		it("reports a TUI that fails to start and exits 1", async () => {
			inkRender.mockImplementation(() => {
				throw new Error("ink exploded")
			})
			expect(await runExpectingExit("hello", flags())).toBe(1)
			expect(stderr()).toContain("Failed to start TUI: ink exploded")
		})

		it("stringifies a non-Error TUI failure", async () => {
			inkRender.mockImplementation(() => {
				throw "no terminal"
			})
			expect(await runExpectingExit("hello", flags())).toBe(1)
			expect(stderr()).toContain("Failed to start TUI: no terminal")
		})

		it("refuses --output-format without --print while a TTY is available", async () => {
			expect(await runExpectingExit("hello", flags({ outputFormat: "json" }))).toBe(1)
			expect(stderr()).toContain("--output-format requires --print mode")
		})
	})

	describe("process-level handlers", () => {
		let registered: Array<[string, (...args: unknown[]) => void]>

		/** Start a run whose task never settles and return its process handlers. */
		async function startHangingRun(options: FlagOptions): Promise<Record<string, (...args: unknown[]) => void>> {
			hostState.taskBehaviour = "hang"
			// The stdin-stream launch does not go through `runTask`, so the driver
			// has to be the thing that never settles for those variants.
			runStdinStreamMode.mockImplementation(() => new Promise<void>(() => {}))
			registered = []
			vi.spyOn(process, "on").mockImplementation(((event: string, listener: (...a: unknown[]) => void) => {
				registered.push([event, listener])
				return process
			}) as never)
			vi.spyOn(process, "off").mockImplementation((() => process) as never)
			exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)

			// The stdin-stream variants refuse a positional prompt, so only the
			// one-shot variants get one.
			void run(options.stdinPromptStream ? undefined : "hi", options)

			for (let i = 0; i < 100 && registered.length < 4; i++) {
				await Promise.resolve()
			}

			return Object.fromEntries(registered) as Record<string, (...args: unknown[]) => void>
		}

		it("shuts down with 130 on SIGINT and 143 on SIGTERM", async () => {
			const handlers = await startHangingRun(flags({ print: true }))

			handlers.SIGINT!()
			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(exitCodes()).toContain(130)

			// A second shutdown is a no-op — `isShuttingDown` guards it.
			const callsAfterFirst = exitSpy.mock.calls.length
			handlers.SIGTERM!()
			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(exitSpy.mock.calls.length).toBe(callsAfterFirst)
		})

		it("shuts down with 143 on SIGTERM", async () => {
			const handlers = await startHangingRun(flags({ print: true }))

			handlers.SIGTERM!()
			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(exitCodes()).toContain(143)
			expect(lastHost().dispose).toHaveBeenCalled()
		})

		it("reports an uncaught exception and shuts down with 1", async () => {
			const handlers = await startHangingRun(flags({ print: true }))

			handlers.uncaughtException!(new Error("boom"))
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(stderr()).toContain("[CLI] Error: uncaughtException: boom")
			expect(exitCodes()).toContain(1)
		})

		it("normalizes a non-Error unhandled rejection", async () => {
			const handlers = await startHangingRun(flags({ print: true }))

			handlers.unhandledRejection!("just a string")
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(stderr()).toContain("[CLI] Error: unhandledRejection: just a string")
			expect(exitCodes()).toContain(1)
		})

		it("swallows an expected control-flow error in stdin stream mode", async () => {
			const handlers = await startHangingRun(
				flags({ print: true, stdinPromptStream: true, outputFormat: "stream-json" }),
			)

			handlers.uncaughtException!(Object.assign(new Error("aborted"), { name: "AbortError" }))
			handlers.unhandledRejection!(Object.assign(new Error("aborted"), { name: "AbortError" }))
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(exitSpy).not.toHaveBeenCalled()
		})

		it("tears down the keep-alive and flushes the emitter when a parked run is signalled", async () => {
			// The park path is the only one that arms the keep-alive interval, so
			// this is where `shutdown` has one to clear — and where it flushes a
			// JSON emitter rather than printing a plain-text goodbye.
			hostState.taskBehaviour = "resolve"
			registered = []
			vi.spyOn(process, "on").mockImplementation(((event: string, listener: (...a: unknown[]) => void) => {
				registered.push([event, listener])
				return process
			}) as never)
			vi.spyOn(process, "off").mockImplementation((() => process) as never)
			exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)

			void run(
				undefined,
				flags({
					print: true,
					stdinPromptStream: true,
					outputFormat: "stream-json",
					signalOnlyExit: true,
				}),
			)

			for (let i = 0; i < 200 && registered.length < 4; i++) {
				await Promise.resolve()
			}

			const parked = Object.fromEntries(registered) as Record<string, (...args: unknown[]) => void>
			parked.SIGTERM!()
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(exitCodes()).toContain(143)
			expect(emitterState.instances[0]!.flush).toHaveBeenCalled()
		})

		it("keeps the process alive on a runtime error under --signal-only-exit", async () => {
			const handlers = await startHangingRun(
				flags({
					print: true,
					stdinPromptStream: true,
					outputFormat: "stream-json",
					signalOnlyExit: true,
				}),
			)

			handlers.uncaughtException!(new Error("boom"))
			handlers.unhandledRejection!(new Error("bang"))
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(exitSpy).not.toHaveBeenCalled()
		})
	})
})
