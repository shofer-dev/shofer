/**
 * Unit tests for `shofer serve` (`src/commands/cli/serve.ts`).
 *
 * The extension host is faked, so nothing binds a socket or boots an agent.
 * What is asserted is the wiring `serve()` owns: the API-configuration
 * override rule (any of provider/model/key/base-url pins the node), the bind
 * that must be awaited before the success banner, the resilience handlers that
 * keep a node up when one task throws, and the per-task activity log.
 *
 * `process.on` is stubbed rather than really registered, so the fake signal and
 * `uncaughtException` deliveries never reach Node's or vitest's own handlers.
 */

import { ShoferEventName } from "@shofer/types"

// NOTE: aliased on purpose. Vitest's SSR transform rewrites references to an
// imported binding by NAME, and the fake host below carries a `serve` class
// field — importing it unaliased makes that field rewrite into the module
// namespace and the file fails to load with a TDZ error.
import { serve as runServe } from "../serve.js"

class ExitSignal extends Error {
	constructor(readonly code: number | undefined) {
		super(`process.exit(${code})`)
		this.name = "ExitSignal"
	}
}

const hostState = vi.hoisted(() => ({
	instances: [] as Array<Record<string, unknown>>,
	/** How the fake HTTP server settles its bind. */
	bind: { kind: "listening" } as { kind: "listening" } | { kind: "error"; code?: string; message?: string },
}))

vi.mock("@/agent/index.js", () => {
	class ExtensionHost {
		options: unknown
		apiListeners = new Map<string, (...args: unknown[]) => void>()
		serverCloseCallbacks: Array<() => void> = []
		activate = vi.fn(async () => {})
		approvalPosture = { summary: "auto-approve nothing (built-in default)" }
		api = {
			on: (event: string, listener: (...args: unknown[]) => void) => {
				this.apiListeners.set(event, listener)
			},
		}
		serve = vi.fn((serverOptions: unknown) => {
			this.serveOptions = serverOptions
			return {
				once: (event: string, listener: (arg?: unknown) => void) => {
					if (hostState.bind.kind === "listening" && event === "listening") {
						listener()
					}
					if (hostState.bind.kind === "error" && event === "error") {
						listener(
							Object.assign(new Error(hostState.bind.message ?? "bind failed"), {
								code: hostState.bind.code,
							}),
						)
					}
				},
				close: (cb: () => void) => {
					this.serverClosed = true
					cb()
				},
			}
		})
		serveOptions: unknown
		serverClosed = false

		constructor(options: unknown) {
			this.options = options
			hostState.instances.push(this as unknown as Record<string, unknown>)
		}
	}

	return { ExtensionHost, unattendedApprovalSeed: () => ({ unattended: true }) }
})

type Handlers = Record<string, (...args: unknown[]) => void>

let registered: Array<[string, (...args: unknown[]) => void]>
let errorLines: string[]
/** Narrow alias so the spy keeps `process.exit`'s own signature. */
const _spyOnExit = () => vi.spyOn(process, "exit")
let exitSpy: ReturnType<typeof _spyOnExit>

function lastHost(): Record<string, unknown> {
	return hostState.instances.at(-1)!
}

function handlers(): Handlers {
	return Object.fromEntries(registered) as Handlers
}

describe("serve", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		hostState.instances = []
		hostState.bind = { kind: "listening" }
		registered = []
		errorLines = []

		vi.spyOn(process, "on").mockImplementation(((event: string, listener: (...a: unknown[]) => void) => {
			registered.push([event, listener])
			return process
		}) as never)
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errorLines.push(args.map(String).join(" "))
		})
		exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new ExitSignal(code)
		}) as never)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	const stderr = () => errorLines.join("\n")

	/**
	 * Start `serve()` and let it reach its shutdown wait. The pending promise is
	 * returned BOXED on purpose — `await` unwraps a nested promise, so returning
	 * it bare would make the helper itself wait for the shutdown that has not
	 * been requested yet.
	 */
	async function startServe(options: Parameters<typeof runServe>[0] = {}): Promise<{ pending: Promise<void> }> {
		const pending = runServe(options)
		for (let i = 0; i < 100 && !registered.some(([event]) => event === "SIGINT"); i++) {
			await Promise.resolve()
		}
		return { pending }
	}

	it("defers to the controller's per-task API configuration with no override flag", async () => {
		const { pending } = await startServe()

		expect(lastHost().serve).toHaveBeenCalledWith({
			port: 30099,
			host: "127.0.0.1",
			token: process.env.SHOFER_NODE_TOKEN,
			allowClientConfig: true,
		})
		expect(stderr()).toContain("API config: per-task from controller")
		expect(stderr()).toContain("approvals: auto-approve nothing (built-in default)")

		handlers().SIGINT!()
		await pending
	})

	it.each(["provider", "model", "apiKey", "baseUrl"] as const)(
		"pins the node's API configuration when --%s is given",
		async (flag) => {
			const { pending } = await startServe({ [flag]: flag === "provider" ? "shofer" : "value" })

			expect(lastHost().serve).toHaveBeenCalledWith(expect.objectContaining({ allowClientConfig: false }))
			expect(stderr()).toContain("API config: pinned to")

			handlers().SIGINT!()
			await pending
		},
	)

	it("carries port, host, token and state dir onto the host and server", async () => {
		const { pending } = await startServe({
			port: "31000",
			host: "0.0.0.0",
			token: "tok",
			stateDir: "/tmp/state",
			workspace: ".",
			extension: "/tmp",
			debug: true,
		})

		expect(lastHost().serve).toHaveBeenCalledWith(
			expect.objectContaining({ port: 31000, host: "0.0.0.0", token: "tok" }),
		)
		expect(lastHost().options).toMatchObject({
			storageDir: "/tmp/state",
			workspacePath: process.cwd(),
			extensionPath: "/tmp",
			debug: true,
			brokerInteractiveAsks: true,
			nonInteractive: true,
		})
		expect(stderr()).toContain("(token auth enabled)")

		handlers().SIGINT!()
		await pending
	})

	it("flips nonInteractive off under --interactive", async () => {
		const { pending } = await startServe({ interactive: true })

		expect(lastHost().options).toMatchObject({ nonInteractive: false, brokerInteractiveAsks: true })

		handlers().SIGINT!()
		await pending
	})

	it("names the port when the bind is refused as in-use", async () => {
		hostState.bind = { kind: "error", code: "EADDRINUSE" }

		await expect(runServe({ port: "31000" })).rejects.toBeInstanceOf(ExitSignal)

		expect(stderr()).toContain("port 31000 on 127.0.0.1 is already in use — pick a free port with --port")
		expect(exitSpy).toHaveBeenCalledWith(1)
	})

	it("reports any other bind failure verbatim", async () => {
		hostState.bind = { kind: "error", code: "EACCES", message: "permission denied" }

		await expect(runServe()).rejects.toBeInstanceOf(ExitSignal)

		expect(stderr()).toContain("failed to start server: permission denied")
	})

	it("keeps the node up when a task throws", async () => {
		const { pending } = await startServe()

		handlers().unhandledRejection!(new Error("task rejected"))
		handlers().unhandledRejection!("not even an error")
		handlers().uncaughtException!(new Error("task threw"))

		expect(stderr()).toContain("unhandledRejection (task error; node stays up): Error: task rejected")
		expect(stderr()).toContain("unhandledRejection (task error; node stays up): not even an error")
		expect(stderr()).toContain("uncaughtException (task error; node stays up): Error: task threw")
		expect(exitSpy).not.toHaveBeenCalled()

		handlers().SIGINT!()
		await pending
	})

	it("logs one line per task lifecycle event", async () => {
		const { pending } = await startServe()
		const host = lastHost() as unknown as { apiListeners: Map<string, (...args: unknown[]) => void> }

		host.apiListeners.get(ShoferEventName.TaskCreated)!("0123456789abcdef")
		host.apiListeners.get(ShoferEventName.TaskStarted)!("0123456789abcdef")
		host.apiListeners.get(ShoferEventName.TaskCompleted)!("0123456789abcdef", {
			totalTokensIn: 10,
			totalTokensOut: 20,
			totalCost: 0.5,
		})
		host.apiListeners.get(ShoferEventName.TaskCompleted)!("0123456789abcdef", {})
		host.apiListeners.get(ShoferEventName.TaskAborted)!("0123456789abcdef", { reason: "user" })
		host.apiListeners.get(ShoferEventName.TaskAborted)!("0123456789abcdef", undefined)
		host.apiListeners.get(ShoferEventName.TaskError)!("0123456789abcdef", "provider_error")

		expect(stderr()).toContain("[shofer] task 01234567 created")
		expect(stderr()).toContain("[shofer] task 01234567 started")
		expect(stderr()).toContain("[shofer] task 01234567 completed · 10 in / 20 out · $0.5000")
		expect(stderr()).toContain("[shofer] task 01234567 completed · ? in / ? out · ?")
		expect(stderr()).toContain("[shofer] task 01234567 aborted (user)")
		expect(stderr()).toContain("[shofer] task 01234567 aborted (?)")
		expect(stderr()).toContain("[shofer] task 01234567 error: provider_error")

		handlers().SIGINT!()
		await pending
	})

	it("wires no activity log under --quiet", async () => {
		const { pending } = await startServe({ quiet: true })
		const host = lastHost() as unknown as { apiListeners: Map<string, unknown> }

		expect(host.apiListeners.size).toBe(0)

		handlers().SIGINT!()
		await pending
	})

	it("closes the server on SIGTERM as well", async () => {
		const { pending } = await startServe()

		handlers().SIGTERM!()
		await pending

		expect((lastHost() as unknown as { serverClosed: boolean }).serverClosed).toBe(true)
	})
})
