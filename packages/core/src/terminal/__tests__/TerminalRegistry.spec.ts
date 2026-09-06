/**
 * `TerminalRegistry` is the vscode-free bookkeeping half of the terminal
 * subsystem: the host owns the platform event wiring, the registry owns which
 * terminals exist, which are busy, and which belong to which task.
 *
 * Its whole state is static, so each test imports the module FRESH
 * (`vi.resetModules()`), which is also what lets `initialize()`'s
 * called-once guard be tested at all. The host bridge must be installed through
 * the SAME (freshly reset) `@shofer/types` instance the registry imported —
 * installing it on the outer instance leaves the registry looking at the
 * default in-memory host, whose `createTerminal` refuses.
 */

type Handler<T> = (arg: T) => void

/** A host whose shell-integration events this suite can fire by hand. */
function makeTerminalHost(types: typeof import("@shofer/types")) {
	const closeHandlers: Handler<unknown>[] = []
	const startHandlers: Handler<any>[] = []
	const endHandlers: Handler<any>[] = []
	const cleanupShellIntegration = vi.fn()
	const disposed: string[] = []

	const disposable = (label: string) => ({ dispose: () => disposed.push(label) })

	const bridge = types.createInMemoryHost()
	types.setHost({
		...bridge,
		terminals: {
			...bridge.terminals,
			onDidCloseTerminal: (h: Handler<unknown>) => (closeHandlers.push(h), disposable("close")),
			onDidStartShellExecution: (h: Handler<any>) => (startHandlers.push(h), disposable("start")),
			onDidEndShellExecution: (h: Handler<any>) => (endHandlers.push(h), disposable("end")),
			cleanupShellIntegration,
			createTerminal: (id: number, cwd: string) => makeHostTerminal(id, cwd),
		},
	} as never)

	return {
		cleanupShellIntegration,
		disposed,
		fireClose: (t: unknown) => closeHandlers.forEach((h) => h(t)),
		fireStart: (e: unknown) => startHandlers.forEach((h) => h(e)),
		fireEnd: (e: unknown) => endHandlers.forEach((h) => h(e)),
	}
}

/** A minimal `ShoferTerminal` shaped like the vscode-backed one. */
function makeHostTerminal(id: number, cwd: string) {
	return {
		id,
		provider: "vscode" as const,
		initialCwd: cwd,
		busy: false,
		running: false,
		taskId: undefined as string | undefined,
		process: undefined as any,
		platformTerminal: { handle: `term-${id}` },
		closed: false,
		isClosed() {
			return this.closed
		},
		getCurrentWorkingDirectory: () => cwd,
		getUnretrievedOutput: () => `output-${id}`,
		getProcessesWithOutput: () => [],
		setActiveStream: vi.fn(),
		shellExecutionComplete: vi.fn(),
	}
}

let host: ReturnType<typeof makeTerminalHost>
let TerminalRegistry: typeof import("../TerminalRegistry.js").TerminalRegistry

// Re-importing the module graph is what buys per-test isolation of the
// registry's static state; under a saturated worker pool the first such import
// comfortably crosses vitest's 10s HOOK timeout (separate from `testTimeout`),
// and the failure reads as a hang rather than as scheduling.
beforeEach(async () => {
	vi.resetModules()
	const types = await import("@shofer/types")
	;({ TerminalRegistry } = await import("../TerminalRegistry.js"))
	host = makeTerminalHost(types)
}, 120_000)

describe("TerminalRegistry — lifecycle", () => {
	it("registers the three shell-integration handlers once and refuses a second initialize", () => {
		TerminalRegistry.initialize()

		expect(() => TerminalRegistry.initialize()).toThrow("should only be called once")
	})

	it("disposes every registered handler on cleanup", () => {
		TerminalRegistry.initialize()

		TerminalRegistry.cleanup()

		expect(host.disposed.sort()).toEqual(["close", "end", "start"])
		expect(host.cleanupShellIntegration).toHaveBeenCalledWith()
		// A second cleanup is a no-op rather than a double dispose.
		TerminalRegistry.cleanup()
		expect(host.disposed).toHaveLength(3)
	})
})

describe("TerminalRegistry — terminal selection", () => {
	it("creates a headless execa terminal when the provider is not vscode", async () => {
		const terminal = TerminalRegistry.createTerminal("/ws", "execa")

		expect(terminal.provider).toBe("execa")
		expect(terminal.getCurrentWorkingDirectory()).toBe("/ws")
	})

	it("hands the same task its own terminal back for the same directory", async () => {
		const first = await TerminalRegistry.getOrCreateTerminal("/ws", "task-1")
		const second = await TerminalRegistry.getOrCreateTerminal("/ws", "task-1")

		expect(second).toBe(first)
	})

	it("does not reuse a BUSY terminal", async () => {
		const first = await TerminalRegistry.getOrCreateTerminal("/ws", "task-1")
		first.busy = true

		const second = await TerminalRegistry.getOrCreateTerminal("/ws", "task-1")

		expect(second).not.toBe(first)
	})

	it("does not reuse a terminal opened in a different directory", async () => {
		const first = await TerminalRegistry.getOrCreateTerminal("/ws/a", "task-1")
		const second = await TerminalRegistry.getOrCreateTerminal("/ws/b", "task-1")

		expect(second).not.toBe(first)
	})

	it("does not reuse a terminal of a different provider", async () => {
		const vscodeTerminal = await TerminalRegistry.getOrCreateTerminal("/ws", "task-1", "vscode")
		const execaTerminal = await TerminalRegistry.getOrCreateTerminal("/ws", "task-1", "execa")

		expect(execaTerminal).not.toBe(vscodeTerminal)
		expect(execaTerminal.provider).toBe("execa")
	})

	it("adopts an idle terminal that belongs to another task, and re-tags it", async () => {
		const first = await TerminalRegistry.getOrCreateTerminal("/ws", "task-1")

		const second = await TerminalRegistry.getOrCreateTerminal("/ws", "task-2")

		expect(second).toBe(first)
		expect(second.taskId).toBe("task-2")
	})

	it("forgets a terminal the user closed", async () => {
		const first: any = await TerminalRegistry.getOrCreateTerminal("/ws", "task-1")
		first.closed = true

		const second = await TerminalRegistry.getOrCreateTerminal("/ws", "task-1")

		expect(second).not.toBe(first)
	})
})

describe("TerminalRegistry — queries", () => {
	it("filters by busy state and by task", async () => {
		const a: any = await TerminalRegistry.getOrCreateTerminal("/ws/a", "task-1")
		const b: any = await TerminalRegistry.getOrCreateTerminal("/ws/b", "task-2")
		a.busy = true

		expect(TerminalRegistry.getTerminals(true)).toEqual([a])
		expect(TerminalRegistry.getTerminals(false)).toEqual([b])
		expect(TerminalRegistry.getTerminals(false, "task-1")).toEqual([])
		expect(TerminalRegistry.getTerminals(false, "task-2")).toEqual([b])
	})

	it("treats only untagged terminals as background ones", async () => {
		const tagged: any = await TerminalRegistry.getOrCreateTerminal("/ws/a", "task-1")
		const background: any = await TerminalRegistry.getOrCreateTerminal("/ws/b")
		background.process = { hasUnretrievedOutput: () => true }

		expect(TerminalRegistry.getBackgroundTerminals()).toEqual([background])
		expect(TerminalRegistry.getBackgroundTerminals(false)).toEqual([background])
		expect(TerminalRegistry.getBackgroundTerminals(true)).toEqual([])
		expect(tagged.taskId).toBe("task-1")
	})

	it("reads unretrieved output and hotness by terminal id, tolerating an unknown id", async () => {
		const terminal: any = await TerminalRegistry.getOrCreateTerminal("/ws", "task-1")
		terminal.process = { isHot: true }

		expect(TerminalRegistry.getUnretrievedOutput(terminal.id)).toBe(`output-${terminal.id}`)
		expect(TerminalRegistry.isProcessHot(terminal.id)).toBe(true)
		expect(TerminalRegistry.getUnretrievedOutput(9999)).toBe("")
		expect(TerminalRegistry.isProcessHot(9999)).toBe(false)
	})

	it("drops a closed terminal from an id lookup and cleans up its shell integration", async () => {
		const terminal: any = await TerminalRegistry.getOrCreateTerminal("/ws", "task-1")
		terminal.closed = true

		expect(TerminalRegistry.getUnretrievedOutput(terminal.id)).toBe("")
		expect(host.cleanupShellIntegration).toHaveBeenCalledWith(terminal.id)
	})

	it("releases every terminal held by a task", async () => {
		const a: any = await TerminalRegistry.getOrCreateTerminal("/ws/a", "task-1")
		const b: any = await TerminalRegistry.getOrCreateTerminal("/ws/b", "task-2")

		TerminalRegistry.releaseTerminalsForTask("task-1")

		expect(a.taskId).toBeUndefined()
		expect(b.taskId).toBe("task-2")
	})
})

describe("TerminalRegistry — shell-integration events", () => {
	async function registeredTerminal() {
		TerminalRegistry.initialize()
		return (await TerminalRegistry.getOrCreateTerminal("/ws", "task-1")) as any
	}

	it("marks a terminal busy and hands it the stream when execution starts", async () => {
		const terminal = await registeredTerminal()
		const stream = { [Symbol.asyncIterator]: () => ({}) }

		host.fireStart({
			terminal: terminal.platformTerminal,
			execution: { commandLine: "ls", read: () => stream },
		})

		expect(terminal.setActiveStream).toHaveBeenCalledWith(stream)
		expect(terminal.busy).toBe(true)
	})

	it("ignores a start event from a terminal Shofer did not create", async () => {
		await registeredTerminal()

		expect(() =>
			host.fireStart({ terminal: { handle: "someone-else" }, execution: { read: () => ({}) } }),
		).not.toThrow()
	})

	it("completes the process and clears busy when execution ends", async () => {
		const terminal = await registeredTerminal()
		terminal.running = true
		terminal.process = { command: "ls" }

		host.fireEnd({ terminal: terminal.platformTerminal, execution: { commandLine: "ls" }, exitCode: 0 })

		expect(terminal.shellExecutionComplete).toHaveBeenCalledWith({ exitCode: 0 })
		expect(terminal.busy).toBe(false)
	})

	it("translates a signal-encoded exit code before completing", async () => {
		const terminal = await registeredTerminal()
		terminal.running = true
		terminal.process = { command: "sleep 100" }

		// 128 + 9 = SIGKILL.
		host.fireEnd({ terminal: terminal.platformTerminal, execution: {}, exitCode: 137 })

		expect(terminal.shellExecutionComplete).toHaveBeenCalledWith(
			expect.objectContaining({ exitCode: 137, signalName: "SIGKILL" }),
		)
	})

	it("clears busy but does not complete when the terminal was not running", async () => {
		const terminal = await registeredTerminal()
		terminal.busy = true
		terminal.running = false

		host.fireEnd({ terminal: terminal.platformTerminal, execution: {}, exitCode: 0 })

		expect(terminal.busy).toBe(false)
		expect(terminal.shellExecutionComplete).not.toHaveBeenCalled()
	})

	it("does nothing when a running terminal has no process", async () => {
		const terminal = await registeredTerminal()
		terminal.running = true
		terminal.busy = true
		terminal.process = undefined

		host.fireEnd({ terminal: terminal.platformTerminal, execution: {}, exitCode: 0 })

		expect(terminal.shellExecutionComplete).not.toHaveBeenCalled()
		expect(terminal.busy).toBe(true)
	})

	it("cleans up shell integration when a registered terminal is closed", async () => {
		const terminal = await registeredTerminal()

		host.fireClose(terminal.platformTerminal)

		expect(host.cleanupShellIntegration).toHaveBeenCalledWith(terminal.id)
	})
})
