import EventEmitter from "events"

export type ShoferTerminalProvider = "vscode" | "execa"

export interface ShoferTerminal {
	provider: ShoferTerminalProvider
	id: number
	busy: boolean
	running: boolean
	taskId?: string
	process?: ShoferTerminalProcess
	getCurrentWorkingDirectory(): string
	isClosed: () => boolean
	runCommand: (command: string, callbacks: ShoferTerminalCallbacks) => ShoferTerminalProcessResultPromise
	setActiveStream(stream: AsyncIterable<string> | undefined, pid?: number): void
	shellExecutionComplete(exitDetails: ExitCodeDetails): void
	getProcessesWithOutput(): ShoferTerminalProcess[]
	getUnretrievedOutput(): string
	getLastCommand(): string
	cleanCompletedProcessQueue(): void
}

export interface ShoferTerminalCallbacks {
	onLine: (line: string, process: ShoferTerminalProcess) => void
	onCompleted: (output: string | undefined, process: ShoferTerminalProcess) => void | Promise<void>
	onShellExecutionStarted: (pid: number | undefined, process: ShoferTerminalProcess) => void
	onShellExecutionComplete: (details: ExitCodeDetails, process: ShoferTerminalProcess) => void
	onNoShellIntegration?: (message: string, process: ShoferTerminalProcess) => void
}

export interface ShoferTerminalProcess extends EventEmitter<ShoferTerminalProcessEvents> {
	command: string
	isHot: boolean
	run: (command: string) => Promise<void>
	continue: () => void
	abort: () => void
	hasUnretrievedOutput: () => boolean
	getUnretrievedOutput: () => string
	trimRetrievedOutput: () => void
}

export type ShoferTerminalProcessResultPromise = ShoferTerminalProcess & Promise<void>

export interface ShoferTerminalProcessEvents {
	line: [line: string]
	continue: []
	completed: [output?: string]
	stream_available: [stream: AsyncIterable<string>]
	shell_execution_started: [pid: number | undefined]
	shell_execution_complete: [exitDetails: ExitCodeDetails]
	error: [error: Error]
	no_shell_integration: [message: string]
}

export interface ExitCodeDetails {
	exitCode: number | undefined
	signal?: number | undefined
	signalName?: string
	coreDumpPossible?: boolean
}
