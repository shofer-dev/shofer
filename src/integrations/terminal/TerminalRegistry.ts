import { getHost } from "@shofer/types"
import type { HostDisposable, HostTerminalHandle } from "@shofer/types"

import { arePathsEqual } from "@shofer/core"

import { ShoferTerminal, ShoferTerminalProvider } from "@shofer/types"
import { BaseTerminalProcess } from "./BaseTerminalProcess"
import { ExecaTerminal } from "./ExecaTerminal"
import { webviewLog } from "@shofer/core"

// Although the host's window terminal list enumerates all open terminals,
// there's no way to know whether they're busy or not (exitStatus does not
// provide useful information for most commands). In order to prevent creating
// too many terminals, we need to keep track of terminals through the life of
// the extension, as well as session specific terminals for the life of a task
// (to get latest unretrieved output).
// Since we have promises keeping track of terminal processes, we get the added
// benefit of keep track of busy terminals even after a task is closed.

export class TerminalRegistry {
	private static terminals: ShoferTerminal[] = []
	private static nextTerminalId = 1
	private static disposables: HostDisposable[] = []
	private static isInitialized = false

	public static initialize() {
		if (this.isInitialized) {
			throw new Error("TerminalRegistry.initialize() should only be called once")
		}

		this.isInitialized = true

		// The host owns the platform-specific terminal/shell-integration event
		// wiring (VS Code in the extension, no-op headless); the registry only
		// keeps the vscode-free bookkeeping.
		const terminals = getHost().terminals

		// Register handler for terminal close events to clean up temporary
		// directories.
		const closeDisposable = terminals.onDidCloseTerminal((hostTerminal) => {
			const terminal = this.getTerminalByHostTerminal(hostTerminal)

			if (terminal) {
				getHost().terminals.cleanupShellIntegration(terminal.id)
			}
		})

		this.disposables.push(closeDisposable)

		try {
			const startDisposable = terminals.onDidStartShellExecution((e) => {
				// Get a handle to the stream as early as possible:
				const stream = e.execution.read()
				const terminal = this.getTerminalByHostTerminal(e.terminal)

				webviewLog.info("[onDidStartTerminalShellExecution]", {
					command: e.execution?.commandLine,
					terminalId: terminal?.id,
				})

				if (terminal) {
					terminal.setActiveStream(stream)
					terminal.busy = true // Mark terminal as busy when shell execution starts
				} else {
					webviewLog.error(
						"[onDidStartTerminalShellExecution] Shell execution started, but not from a Shofer-registered terminal:",
						e,
					)
				}
			})

			this.disposables.push(startDisposable)

			const endDisposable = terminals.onDidEndShellExecution((e) => {
				const terminal = this.getTerminalByHostTerminal(e.terminal)
				const process = terminal?.process
				const exitDetails = BaseTerminalProcess.interpretExitCode(e.exitCode)

				webviewLog.info("[onDidEndTerminalShellExecution]", {
					command: e.execution?.commandLine,
					terminalId: terminal?.id,
					...exitDetails,
				})

				if (!terminal) {
					webviewLog.error(
						"[onDidEndTerminalShellExecution] Shell execution ended, but not from a Shofer-registered terminal:",
						e,
					)

					return
				}

				if (!terminal.running) {
					webviewLog.error(
						"[TerminalRegistry] Shell execution end event received, but process is not running for terminal:",
						{ terminalId: terminal?.id, command: process?.command, exitCode: e.exitCode },
					)

					terminal.busy = false
					return
				}

				if (!process) {
					webviewLog.error(
						"[TerminalRegistry] Shell execution end event received on running terminal, but process is undefined:",
						{ terminalId: terminal.id, exitCode: e.exitCode },
					)

					return
				}

				// Signal completion to any waiting processes.
				terminal.shellExecutionComplete(exitDetails)
				terminal.busy = false // Mark terminal as not busy when shell execution ends
			})

			this.disposables.push(endDisposable)
		} catch (error) {
			webviewLog.error("[TerminalRegistry] Error setting up shell execution handlers:", error)
		}
	}

	public static createTerminal(cwd: string, provider: ShoferTerminalProvider): ShoferTerminal {
		let newTerminal

		if (provider === "vscode") {
			newTerminal = getHost().terminals.createTerminal(this.nextTerminalId++, cwd)
		} else {
			newTerminal = new ExecaTerminal(this.nextTerminalId++, cwd)
		}

		this.terminals.push(newTerminal)

		return newTerminal
	}

	/**
	 * Gets an existing terminal or creates a new one for the given working
	 * directory.
	 *
	 * @param cwd The working directory path
	 * @param taskId Optional task ID to associate with the terminal
	 * @returns A Terminal instance
	 */
	public static async getOrCreateTerminal(
		cwd: string,
		taskId?: string,
		provider: ShoferTerminalProvider = "vscode",
	): Promise<ShoferTerminal> {
		const terminals = this.getAllTerminals()
		let terminal: ShoferTerminal | undefined

		// First priority: Find a terminal already assigned to this task with
		// matching directory.
		if (taskId) {
			terminal = terminals.find((t) => {
				if (t.busy || t.taskId !== taskId || t.provider !== provider) {
					return false
				}

				const terminalCwd = t.getCurrentWorkingDirectory()

				if (!terminalCwd) {
					return false
				}

				return arePathsEqual(cwd, terminalCwd)
			})
		}

		// Second priority: Find any available terminal with matching directory.
		if (!terminal) {
			terminal = terminals.find((t) => {
				if (t.busy || t.provider !== provider) {
					return false
				}

				const terminalCwd = t.getCurrentWorkingDirectory()

				if (!terminalCwd) {
					return false
				}

				return arePathsEqual(cwd, terminalCwd)
			})
		}

		// If no suitable terminal found, create a new one.
		if (!terminal) {
			terminal = this.createTerminal(cwd, provider)
		}

		terminal.taskId = taskId

		return terminal
	}

	/**
	 * Gets unretrieved output from a terminal process.
	 *
	 * @param id The terminal ID
	 * @returns The unretrieved output as a string, or empty string if terminal not found
	 */
	public static getUnretrievedOutput(id: number): string {
		return this.getTerminalById(id)?.getUnretrievedOutput() ?? ""
	}

	/**
	 * Checks if a terminal process is "hot" (recently active).
	 *
	 * @param id The terminal ID
	 * @returns True if the process is hot, false otherwise
	 */
	public static isProcessHot(id: number): boolean {
		return this.getTerminalById(id)?.process?.isHot ?? false
	}

	/**
	 * Gets terminals filtered by busy state and optionally by task id.
	 *
	 * @param busy Whether to get busy or non-busy terminals
	 * @param taskId Optional task ID to filter terminals by
	 * @returns Array of Terminal objects
	 */
	public static getTerminals(busy: boolean, taskId?: string): ShoferTerminal[] {
		return this.getAllTerminals().filter((t) => {
			// Filter by busy state.
			if (t.busy !== busy) {
				return false
			}

			// If taskId is provided, also filter by taskId.
			if (taskId !== undefined && t.taskId !== taskId) {
				return false
			}

			return true
		})
	}

	/**
	 * Gets background terminals (taskId undefined) that have unretrieved output
	 * or are still running.
	 *
	 * @param busy Whether to get busy or non-busy terminals
	 * @returns Array of Terminal objects
	 */
	public static getBackgroundTerminals(busy?: boolean): ShoferTerminal[] {
		return this.getAllTerminals().filter((t) => {
			// Only get background terminals (taskId undefined).
			if (t.taskId !== undefined) {
				return false
			}

			// If busy is undefined, return all background terminals.
			if (busy === undefined) {
				return t.getProcessesWithOutput().length > 0 || t.process?.hasUnretrievedOutput()
			}

			// Filter by busy state.
			return t.busy === busy
		})
	}

	public static cleanup() {
		// Clean up all temporary directories.
		getHost().terminals.cleanupShellIntegration()
		this.disposables.forEach((disposable) => disposable.dispose())
		this.disposables = []
	}

	/**
	 * Releases all terminals associated with a task.
	 *
	 * @param taskId The task ID
	 */
	public static releaseTerminalsForTask(taskId: string): void {
		this.terminals.forEach((terminal) => {
			if (terminal.taskId === taskId) {
				terminal.taskId = undefined
			}
		})
	}

	private static getAllTerminals(): ShoferTerminal[] {
		this.terminals = this.terminals.filter((t) => !t.isClosed())
		return this.terminals
	}

	private static getTerminalById(id: number): ShoferTerminal | undefined {
		const terminal = this.terminals.find((t) => t.id === id)

		if (terminal?.isClosed()) {
			this.removeTerminal(id)
			return undefined
		}

		return terminal
	}

	/**
	 * Gets a terminal by the opaque host terminal handle carried on shell-integration
	 * events (identity match against the vscode-backed terminal it wraps).
	 * @param hostTerminal The host terminal handle from a shell-execution/close event
	 * @returns The Terminal object, or undefined if not found
	 */
	private static getTerminalByHostTerminal(hostTerminal: HostTerminalHandle): ShoferTerminal | undefined {
		const found = this.terminals.find((t) => t.platformTerminal === hostTerminal)

		if (found?.isClosed()) {
			this.removeTerminal(found.id)
			return undefined
		}

		return found
	}

	private static removeTerminal(id: number) {
		getHost().terminals.cleanupShellIntegration(id)
		this.terminals = this.terminals.filter((t) => t.id !== id)
	}
}
