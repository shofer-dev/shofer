// npx vitest src/integrations/terminal/__tests__/Terminal.test.ts

/**
 * The VS Code terminal adapter. Two areas carry the behaviour:
 *
 *  - `getEnv()`, which composes the environment a Shofer terminal is spawned
 *    with. Every entry is a workaround for a specific shell/VS Code defect, so
 *    each one is conditional on its own setting — pinning them keeps a setting
 *    from silently losing its effect.
 *  - `runCommand()`, which waits for shell integration before executing. The
 *    timeout path must NOT reject: it emits `no_shell_integration` and lets the
 *    caller decide, because rejecting there turns "your shell has no integration"
 *    into an unhandled failure of the tool call.
 */

const hoisted = vi.hoisted(() => ({
	createTerminal: vi.fn((..._args: unknown[]): { name: string; show: () => void; exitStatus: unknown } => ({
		name: "Shofer",
		show: vi.fn(),
		exitStatus: undefined,
	})),
	executeCommand: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
	clipboard: { readText: vi.fn(async () => ""), writeText: vi.fn(async () => undefined) },
	zshInitTmpDir: vi.fn((env: Record<string, string>) => {
		env.ROO_ZDOTDIR = "/original"
		return "/tmp/zdot"
	}),
	zshCleanupTmpDir: vi.fn(() => true),
	terminalTmpDirs: new Map<number, string>(),
	processRun: vi.fn(),
	logs: [] as string[],
}))

vi.mock("vscode", () => ({
	ThemeIcon: class {
		constructor(public id: string) {}
	},
	window: { createTerminal: hoisted.createTerminal },
	commands: { executeCommand: hoisted.executeCommand },
	env: { clipboard: hoisted.clipboard },
}))

vi.mock("../ShellIntegrationManager", () => ({
	ShellIntegrationManager: {
		terminalTmpDirs: hoisted.terminalTmpDirs,
		zshInitTmpDir: hoisted.zshInitTmpDir,
		zshCleanupTmpDir: hoisted.zshCleanupTmpDir,
	},
}))

vi.mock("../TerminalProcess", async () => {
	const { EventEmitter } = await import("events")
	class TerminalProcess extends EventEmitter {
		command = ""
		run = hoisted.processRun
	}
	return { TerminalProcess }
})

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	webviewLog: {
		info: (m: string) => hoisted.logs.push(m),
		error: (m: string) => hoisted.logs.push(m),
		warn: vi.fn(),
		debug: vi.fn(),
	},
}))

import { Terminal } from "../Terminal"

type Settings = {
	zdotdir?: boolean
	ohMy?: boolean
	p10k?: boolean
	clearEolMark?: boolean
	commandDelay?: number
	shellIntegrationTimeout?: number
}

function stubSettings(settings: Settings = {}) {
	vi.spyOn(Terminal, "getTerminalZdotdir").mockReturnValue(settings.zdotdir ?? false)
	vi.spyOn(Terminal, "getTerminalZshOhMy").mockReturnValue(settings.ohMy ?? false)
	vi.spyOn(Terminal, "getTerminalZshP10k").mockReturnValue(settings.p10k ?? false)
	vi.spyOn(Terminal, "getTerminalZshClearEolMark").mockReturnValue(settings.clearEolMark ?? false)
	vi.spyOn(Terminal, "getCommandDelay").mockReturnValue(settings.commandDelay ?? 0)
	vi.spyOn(Terminal, "getShellIntegrationTimeout").mockReturnValue(settings.shellIntegrationTimeout ?? 50)
}

function callbacks() {
	return {
		onLine: vi.fn(),
		onCompleted: vi.fn(),
		onShellExecutionStarted: vi.fn(),
		onShellExecutionComplete: vi.fn(),
		onNoShellIntegration: vi.fn(),
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.restoreAllMocks()
	hoisted.logs = []
	hoisted.terminalTmpDirs.clear()
	stubSettings()
})

describe("getEnv", () => {
	it("always marks the terminal as Shofer's and disables VTE", () => {
		const env = Terminal.getEnv()

		expect(env.SHOFER_ACTIVE).toBe("true")
		expect(env.VTE_VERSION).toBe("0")
	})

	it("disables the pager off-Windows so a command cannot block on `less`", () => {
		const env = Terminal.getEnv()
		expect(env.PAGER).toBe(process.platform === "win32" ? "" : "cat")
	})

	it("adds NOTHING optional when every shell setting is off", () => {
		const env = Terminal.getEnv()

		expect(env.ITERM_SHELL_INTEGRATION_INSTALLED).toBeUndefined()
		expect(env.POWERLEVEL9K_TERM_SHELL_INTEGRATION).toBeUndefined()
		expect(env.PROMPT_COMMAND).toBeUndefined()
		expect(env.PROMPT_EOL_MARK).toBeUndefined()
		expect(env.ZDOTDIR).toBeUndefined()
	})

	it("declares Oh My Zsh integration when that setting is on", () => {
		stubSettings({ ohMy: true })
		expect(Terminal.getEnv().ITERM_SHELL_INTEGRATION_INSTALLED).toBe("Yes")
	})

	it("declares Powerlevel10k integration when that setting is on", () => {
		stubSettings({ p10k: true })
		expect(Terminal.getEnv().POWERLEVEL9K_TERM_SHELL_INTEGRATION).toBe("true")
	})

	it("turns the command delay into a PROMPT_COMMAND sleep expressed in SECONDS", () => {
		stubSettings({ commandDelay: 250 })
		expect(Terminal.getEnv().PROMPT_COMMAND).toBe("sleep 0.25")
	})

	it("clears the ZSH EOL mark when asked", () => {
		stubSettings({ clearEolMark: true })
		expect(Terminal.getEnv().PROMPT_EOL_MARK).toBe("")
	})

	it("provisions a throwaway ZDOTDIR when the zsh shim is enabled", () => {
		stubSettings({ zdotdir: true })

		const env = Terminal.getEnv()

		expect(hoisted.zshInitTmpDir).toHaveBeenCalledWith(env)
		expect(env.ZDOTDIR).toBe("/tmp/zdot")
	})
})

describe("construction", () => {
	it("creates a terminal with the Shofer name, icon, cwd and env", () => {
		new Terminal(1, undefined, "/workspace")

		expect(hoisted.createTerminal).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/workspace", name: "Shofer" }),
		)
		const [created] = hoisted.createTerminal.mock.calls[0] as [{ env: Record<string, string> }]
		expect(created.env.SHOFER_ACTIVE).toBe("true")
	})

	it("ADOPTS a terminal it is handed instead of creating one", () => {
		const existing = { name: "existing" } as never

		const terminal = new Terminal(1, existing, "/workspace")

		expect(hoisted.createTerminal).not.toHaveBeenCalled()
		expect(terminal.terminal).toBe(existing)
		expect(terminal.platformTerminal).toBe(existing)
	})

	it("registers the ZDOTDIR temp directory against the terminal id, so it can be cleaned up", () => {
		stubSettings({ zdotdir: true })

		new Terminal(42, undefined, "/workspace")

		expect(hoisted.terminalTmpDirs.get(42)).toBe("/tmp/zdot")
	})

	it("registers nothing when the zsh shim is off", () => {
		new Terminal(42, undefined, "/workspace")
		expect(hoisted.terminalTmpDirs.size).toBe(0)
	})
})

describe("state accessors", () => {
	it("prefers shell integration's cwd over the one the terminal was created with", () => {
		const terminal = new Terminal(1, { shellIntegration: { cwd: { fsPath: "/moved" } } } as never, "/workspace")
		expect(terminal.getCurrentWorkingDirectory()).toBe("/moved")
	})

	it("falls back to the initial cwd with no shell integration", () => {
		const terminal = new Terminal(1, {} as never, "/workspace")
		expect(terminal.getCurrentWorkingDirectory()).toBe("/workspace")
	})

	it("is 'closed' exactly when VS Code has set an exit status", () => {
		expect(new Terminal(1, { exitStatus: undefined } as never, "/w").isClosed()).toBe(false)
		expect(new Terminal(1, { exitStatus: { code: 0 } } as never, "/w").isClosed()).toBe(true)
	})

	it("forwards show(preserveFocus) to the underlying terminal", () => {
		const show = vi.fn()
		new Terminal(1, { show } as never, "/w").show(true)
		expect(show).toHaveBeenCalledWith(true)
	})
})

describe("runCommand", () => {
	it("marks the terminal BUSY before waiting, so nothing else claims it", () => {
		const terminal = new Terminal(1, { shellIntegration: {} } as never, "/w")

		void terminal.runCommand("ls", callbacks())

		expect(terminal.busy).toBe(true)
	})

	it("runs the command once shell integration appears, and cleans up the ZDOTDIR shim", async () => {
		const terminal = new Terminal(1, { shellIntegration: {} } as never, "/w")
		const cb = callbacks()

		const promise = terminal.runCommand("ls -la", cb)
		await vi.waitFor(() => expect(hoisted.processRun).toHaveBeenCalledWith("ls -la"))

		expect(hoisted.zshCleanupTmpDir).toHaveBeenCalledWith(1)
		terminal.process!.emit("continue")
		await expect(promise).resolves.toBeUndefined()
	})

	it("EMITS no_shell_integration rather than rejecting when integration never arrives", async () => {
		const terminal = new Terminal(1, {} as never, "/w")
		const cb = callbacks()

		const promise = terminal.runCommand("ls", cb)
		await vi.waitFor(() => expect(cb.onNoShellIntegration).toHaveBeenCalled())

		expect(hoisted.processRun).not.toHaveBeenCalled()
		expect(hoisted.zshCleanupTmpDir).toHaveBeenCalledWith(1)
		expect(cb.onNoShellIntegration.mock.calls[0][0]).toContain("Shell integration initialization sequence")
		terminal.process!.emit("continue")
		await expect(promise).resolves.toBeUndefined()
	})

	it("wires every callback to its process event", async () => {
		const terminal = new Terminal(1, { shellIntegration: {} } as never, "/w")
		const cb = callbacks()

		const promise = terminal.runCommand("ls", cb)
		const process = terminal.process!

		process.emit("line", "output")
		process.emit("completed", "all output")
		process.emit("shell_execution_started", 1234)
		process.emit("shell_execution_complete", { exitCode: 0 })

		expect(cb.onLine).toHaveBeenCalledWith("output", process)
		expect(cb.onCompleted).toHaveBeenCalledWith("all output", process)
		expect(cb.onShellExecutionStarted).toHaveBeenCalledWith(1234, process)
		expect(cb.onShellExecutionComplete).toHaveBeenCalledWith({ exitCode: 0 }, process)

		process.emit("continue")
		await promise
	})

	it("rejects — and logs — when the process itself errors", async () => {
		const terminal = new Terminal(1, { shellIntegration: {} } as never, "/w")

		const promise = terminal.runCommand("ls", callbacks())
		terminal.process!.emit("error", new Error("spawn failed"))

		await expect(promise).rejects.toThrow("spawn failed")
		expect(hoisted.logs.join(" ")).toContain("error:")
	})
})

describe("getTerminalContents", () => {
	function clipboardSequence(...values: string[]) {
		let i = 0
		hoisted.clipboard.readText.mockImplementation(async () => values[Math.min(i++, values.length - 1)])
	}

	it("selects ALL scrollback for the -1 form", async () => {
		clipboardSequence("original", "captured")

		await Terminal.getTerminalContents(-1)

		expect(hoisted.executeCommand).toHaveBeenCalledWith("workbench.action.terminal.selectAll")
	})

	it("walks back N commands for a positive count", async () => {
		clipboardSequence("original", "captured")

		await Terminal.getTerminalContents(2)

		const backSelections = hoisted.executeCommand.mock.calls.filter(
			([c]) => c === "workbench.action.terminal.selectToPreviousCommand",
		)
		expect(backSelections).toHaveLength(2)
	})

	it("RESTORES the user's clipboard afterwards — this borrows it", async () => {
		clipboardSequence("user's own text", "captured")

		await Terminal.getTerminalContents(-1)

		expect(hoisted.clipboard.writeText).toHaveBeenCalledWith("user's own text")
	})

	it("returns EMPTY when the clipboard did not change — nothing was captured", async () => {
		clipboardSequence("unchanged", "unchanged")

		await expect(Terminal.getTerminalContents(-1)).resolves.toBe("")
	})

	it("trims the capture back to the block starting at the prompt line", async () => {
		clipboardSequence("original", "noise\n$ npm test\nfailing\n$ npm test")

		await expect(Terminal.getTerminalContents(1)).resolves.toBe("$ npm test\nfailing")
	})

	it("keeps everything when no earlier line matches the prompt", async () => {
		clipboardSequence("original", "line one\nline two\nzzz")

		await expect(Terminal.getTerminalContents(1)).resolves.toBe("line one\nline two")
	})

	it("restores the clipboard even when the selection commands blow up", async () => {
		clipboardSequence("user's own text")
		hoisted.executeCommand.mockRejectedValueOnce(new Error("no terminal"))

		await expect(Terminal.getTerminalContents(-1)).rejects.toThrow("no terminal")
		expect(hoisted.clipboard.writeText).toHaveBeenCalledWith("user's own text")
	})
})
