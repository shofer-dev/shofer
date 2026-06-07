/**
 * ExtensionHost - Loads and runs the Shofer extension in CLI mode
 *
 * This class is a thin coordination layer responsible for:
 * 1. Creating the vscode-shim mock
 * 2. Loading the extension bundle via require()
 * 3. Activating the extension
 * 4. Wiring up managers for output, prompting, and ask handling
 */

import { createRequire } from "module"
import path from "path"
import { fileURLToPath } from "url"
import fs from "fs"
import { EventEmitter } from "events"

import pWaitFor from "p-wait-for"

import type {
	ShoferMessage,
	ExtensionMessage,
	ReasoningEffortExtended,
	ShoferSettings,
	WebviewMessage,
	ShoferAPI,
	QueuedMessage,
} from "@shofer/types"
import { ShoferEventName } from "@shofer/types"
import { createVSCodeAPI, IExtensionHost, ExtensionHostEventMap, setRuntimeConfigValues } from "@shofer/vscode-shim"
import { DebugLogger, setDebugLogEnabled } from "@shofer/core/cli"

import { DEFAULT_FLAGS, type SupportedProvider } from "@/types/index.js"
import type { User } from "@/lib/sdk/index.js"
import { getProviderSettings } from "@/lib/utils/provider.js"
import { createEphemeralStorageDir } from "@/lib/storage/index.js"

import type { WaitingForInputEvent, TaskCompletedEvent } from "./events.js"
import type { AgentStateInfo } from "./agent-state.js"
import { ExtensionClient } from "./extension-client.js"
import { OutputManager } from "./output-manager.js"
import { PromptManager } from "./prompt-manager.js"
import { AskDispatcher } from "./ask-dispatcher.js"

// Pre-configured logger for CLI message activity debugging.
const cliLogger = new DebugLogger("CLI")

// Get the CLI package root directory (for finding node_modules/@vscode/ripgrep)
// When running from a release tarball, ROO_CLI_ROOT is set by the wrapper script.
// In development, we fall back to finding the CLI package root by walking up to package.json.
// This works whether running from dist/ (bundled) or src/agent/ (tsx dev).
const __dirname = path.dirname(fileURLToPath(import.meta.url))

function findCliPackageRoot(): string {
	let dir = __dirname

	while (dir !== path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, "package.json"))) {
			return dir
		}

		dir = path.dirname(dir)
	}

	return path.resolve(__dirname, "..")
}

const CLI_PACKAGE_ROOT = process.env.ROO_CLI_ROOT || findCliPackageRoot()

export interface ExtensionHostOptions {
	mode: string
	reasoningEffort?: ReasoningEffortExtended | "unspecified" | "disabled"
	consecutiveMistakeLimit?: number
	user: User | null
	provider: SupportedProvider
	apiKey?: string
	model: string
	baseUrl?: string
	workspacePath: string
	extensionPath: string
	nonInteractive?: boolean
	/**
	 * When true, uses a temporary storage directory that is cleaned up on exit.
	 */
	ephemeral: boolean
	debug: boolean
	exitOnComplete: boolean
	terminalShell?: string
	/**
	 * When true, exit the process on API request errors instead of retrying.
	 */
	exitOnError?: boolean
	/**
	 * When true, completely disables all direct stdout/stderr output.
	 * Use this when running in TUI mode where Ink controls the terminal.
	 */
	disableOutput?: boolean
	/**
	 * When true, don't suppress node warnings and console output since we're
	 * running in an integration test and we want to see the output.
	 */
	integrationTest?: boolean
}

interface ExtensionModule {
	activate: (context: unknown) => Promise<unknown>
	deactivate?: () => Promise<void>
}

interface WebviewViewProvider {
	resolveWebviewView?(webviewView: unknown, context: unknown, token: unknown): void | Promise<void>
}

export interface ExtensionHostInterface extends IExtensionHost<ExtensionHostEventMap> {
	client: ExtensionClient
	activate(): Promise<void>
	runTask(prompt: string, taskId?: string, configuration?: ShoferSettings, images?: string[]): Promise<void>
	cancelTask(): Promise<void>
	resumeTask(taskId: string): Promise<void>
	sendToExtension(message: WebviewMessage): void
	dispose(): Promise<void>
}

export class ExtensionHost extends EventEmitter implements ExtensionHostInterface {
	// Extension lifecycle.
	private vscode: ReturnType<typeof createVSCodeAPI> | null = null
	private extensionModule: ExtensionModule | null = null
	private extensionAPI: ShoferAPI | null = null
	private options: ExtensionHostOptions
	private _isReady = false
	private messageListener: ((message: ExtensionMessage) => void) | null = null
	private initialSettings: ShoferSettings

	// Console suppression.
	private originalConsole: {
		log: typeof console.log
		warn: typeof console.warn
		error: typeof console.error
		debug: typeof console.debug
		info: typeof console.info
	} | null = null

	private originalProcessEmitWarning: typeof process.emitWarning | null = null

	// Ephemeral storage.
	private ephemeralStorageDir: string | null = null
	private previousCliRuntimeEnv: string | undefined

	// ==========================================================================
	// Managers - These do all the heavy lifting
	// ==========================================================================

	/**
	 * ExtensionClient: Single source of truth for agent loop state.
	 * Handles message processing and state detection.
	 */
	public readonly client: ExtensionClient

	/**
	 * OutputManager: Handles all CLI output and streaming.
	 * Uses Observable pattern internally for stream tracking.
	 */
	private outputManager: OutputManager

	/**
	 * PromptManager: Handles all user input collection.
	 * Provides readline, yes/no, and timed prompts.
	 */
	private promptManager: PromptManager

	/**
	 * AskDispatcher: Routes asks to appropriate handlers.
	 * Uses type guards (isIdleAsk, isInteractiveAsk, etc.) from client module.
	 */
	private askDispatcher: AskDispatcher

	// ==========================================================================
	// Constructor
	// ==========================================================================

	constructor(options: ExtensionHostOptions) {
		super()

		this.options = options
		// Mark this process as CLI runtime so extension code can apply
		// CLI-specific behavior without affecting VS Code desktop usage.
		this.previousCliRuntimeEnv = process.env.ROO_CLI_RUNTIME
		process.env.ROO_CLI_RUNTIME = "1"

		// Enable file-based debug logging only when --debug is passed.
		if (options.debug) {
			setDebugLogEnabled(true)
		}

		// Set up quiet mode early, before any extension code runs.
		// This suppresses console output from the extension during load.
		this.setupQuietMode()

		// Initialize client - single source of truth for agent state (including mode).
		this.client = new ExtensionClient({
			sendMessage: (msg) => this.sendToExtension(msg),
			debug: options.debug, // Enable debug logging in the client.
		})

		// Initialize output manager.
		this.outputManager = new OutputManager({ disabled: options.disableOutput })

		// Initialize prompt manager with console mode callbacks.
		this.promptManager = new PromptManager({
			onBeforePrompt: () => this.restoreConsole(),
			onAfterPrompt: () => this.setupQuietMode(),
		})

		// Initialize ask dispatcher.
		this.askDispatcher = new AskDispatcher({
			outputManager: this.outputManager,
			promptManager: this.promptManager,
			sendMessage: (msg) => this.sendToExtension(msg),
			nonInteractive: options.nonInteractive,
			exitOnError: options.exitOnError,
			disabled: options.disableOutput, // TUI mode handles asks directly.
		})

		// Wire up client events.
		this.setupClientEventHandlers()

		// Populate initial settings.
		const baseSettings: ShoferSettings = {
			mode: this.options.mode,
			consecutiveMistakeLimit: this.options.consecutiveMistakeLimit ?? DEFAULT_FLAGS.consecutiveMistakeLimit,
			commandExecutionTimeout: 300,
			enableCheckpoints: false,
			experiments: {
				customTools: true,
			},
			...getProviderSettings(
				this.options.provider,
				this.options.apiKey,
				this.options.model,
				this.options.baseUrl,
			),
		}

		this.initialSettings = this.options.nonInteractive
			? {
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: true,
					alwaysAllowWrite: true,
					alwaysAllowWriteOutsideWorkspace: true,
					alwaysAllowWriteProtected: true,
					alwaysAllowMcp: true,
					alwaysAllowModeSwitch: true,
					alwaysAllowSubtasks: true,
					alwaysAllowExecute: true,
					allowedCommands: ["*"],
					...baseSettings,
				}
			: {
					autoApprovalEnabled: false,
					...baseSettings,
				}

		if (this.options.reasoningEffort && this.options.reasoningEffort !== "unspecified") {
			if (this.options.reasoningEffort === "disabled") {
				this.initialSettings.enableReasoningEffort = false
			} else {
				this.initialSettings.enableReasoningEffort = true
				this.initialSettings.reasoningEffort = this.options.reasoningEffort
			}
		}

		if (this.options.terminalShell) {
			this.initialSettings.terminalShellIntegrationDisabled = true
			this.initialSettings.execaShellPath = this.options.terminalShell
		}
	}

	// ==========================================================================
	// Client Event Handlers
	// ==========================================================================

	/**
	 * Wire up client events to managers.
	 * The client emits events, managers handle them.
	 */
	private setupClientEventHandlers(): void {
		// Handle new messages - delegate to OutputManager.
		this.client.on("message", (msg: ShoferMessage) => {
			this.logMessageDebug(msg, "new")
			this.outputManager.outputMessage(msg)
		})

		// Handle message updates - delegate to OutputManager.
		this.client.on("messageUpdated", (msg: ShoferMessage) => {
			this.logMessageDebug(msg, "updated")
			this.outputManager.outputMessage(msg)
		})

		// Handle waiting for input - delegate to AskDispatcher.
		this.client.on("waitingForInput", (event: WaitingForInputEvent) => {
			this.askDispatcher.handleAsk(event.message)
		})

		// Handle task completion.
		this.client.on("taskCompleted", (event: TaskCompletedEvent) => {
			// Output completion message via OutputManager.
			// Note: completion_result is an "ask" type, not a "say" type.
			if (event.message && event.message.type === "ask" && event.message.ask === "completion_result") {
				this.outputManager.outputCompletionResult(event.message.ts, event.message.text || "")
			}
		})
	}

	// ==========================================================================
	// Logging + Console Suppression
	// ==========================================================================

	private setupQuietMode(): void {
		// Skip if already set up or if integrationTest mode
		if (this.originalConsole || this.options.integrationTest) {
			return
		}

		// Suppress node warnings.
		this.originalProcessEmitWarning = process.emitWarning
		process.emitWarning = () => {}
		process.on("warning", () => {})

		// Suppress console output.
		this.originalConsole = {
			log: console.log,
			warn: console.warn,
			error: console.error,
			debug: console.debug,
			info: console.info,
		}

		console.log = () => {}
		console.warn = () => {}
		console.debug = () => {}
		console.info = () => {}
	}

	private restoreConsole(): void {
		if (!this.originalConsole) {
			return
		}

		console.log = this.originalConsole.log
		console.warn = this.originalConsole.warn
		console.error = this.originalConsole.error
		console.debug = this.originalConsole.debug
		console.info = this.originalConsole.info
		this.originalConsole = null

		if (this.originalProcessEmitWarning) {
			process.emitWarning = this.originalProcessEmitWarning
			this.originalProcessEmitWarning = null
		}
	}

	private logMessageDebug(msg: ShoferMessage, type: "new" | "updated"): void {
		if (msg.partial) {
			if (!this.outputManager.hasLoggedFirstPartial(msg.ts)) {
				this.outputManager.setLoggedFirstPartial(msg.ts)
				cliLogger.debug("message:start", { ts: msg.ts, type: msg.say || msg.ask })
			}
		} else {
			cliLogger.debug(`message:${type === "new" ? "new" : "complete"}`, { ts: msg.ts, type: msg.say || msg.ask })
			this.outputManager.clearLoggedFirstPartial(msg.ts)
		}
	}

	// ==========================================================================
	// Extension Lifecycle
	// ==========================================================================

	public async activate(): Promise<void> {
		const bundlePath = path.join(this.options.extensionPath, "extension.js")

		if (!fs.existsSync(bundlePath)) {
			this.restoreConsole()
			throw new Error(`Extension bundle not found at: ${bundlePath}`)
		}

		let storageDir: string | undefined

		if (this.options.ephemeral) {
			this.ephemeralStorageDir = await createEphemeralStorageDir()
			storageDir = this.ephemeralStorageDir
		}

		// Create VSCode API mock.
		this.vscode = createVSCodeAPI(this.options.extensionPath, this.options.workspacePath, undefined, {
			appRoot: CLI_PACKAGE_ROOT,
			storageDir,
		})
		;(global as Record<string, unknown>).vscode = this.vscode
		;(global as Record<string, unknown>).__extensionHost = this

		// Write a real vscode-mock.js file to a temp directory so Node can
		// physically resolve it. In-memory cache entries and _load monkey-patches
		// do not survive the ESM loader used by tsx — only a real on-disk file
		// works reliably across both CJS and ESM module resolution paths.
		const mockDir = this.ephemeralStorageDir ?? path.join(this.options.workspacePath, ".shofer", "tmp")
		fs.mkdirSync(mockDir, { recursive: true })
		const mockFilePath = path.join(mockDir, "vscode-mock.js")

		// The mock file re-exports the full vscode API object from global.vscode.
		fs.writeFileSync(
			mockFilePath,
			[
				`"use strict";`,
				`var g = globalThis;`,
				`if (!g.vscode) { throw new Error("global.vscode not set before vscode-mock load"); }`,
				`module.exports = g.vscode;`,
				``,
			].join("\n"),
			"utf-8",
		)

		// Redirect require("vscode") → the real mock file on disk.
		const require = createRequire(import.meta.url)
		const Module = require("module")
		const originalResolve = Module._resolveFilename
		Module._resolveFilename = function (request: string, parent: unknown, isMain: boolean, options: unknown) {
			if (request === "vscode") return mockFilePath
			return originalResolve.call(this, request, parent, isMain, options)
		}

		try {
			cliLogger.debug("loading extension bundle...")
			this.extensionModule = require(bundlePath) as ExtensionModule
			cliLogger.debug("bundle loaded")
		} catch (error) {
			Module._resolveFilename = originalResolve
			throw new Error(
				`Failed to load extension bundle: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		// Restore resolution immediately — the bundle has loaded.
		Module._resolveFilename = originalResolve

		try {
			cliLogger.debug("activating extension...")
			this.extensionAPI = (await this.extensionModule.activate(this.vscode.context)) as ShoferAPI
			cliLogger.debug("extension activated")
		} catch (error) {
			throw new Error(`Failed to activate extension: ${error instanceof Error ? error.message : String(error)}`)
		}

		// Set up message listener - forward all messages to client.
		this.messageListener = (message: ExtensionMessage) => this.client.handleMessage(message)
		this.on("extensionWebviewMessage", this.messageListener)

		// Forward ShoferAPI events to complement the webview-message-based event stream.
		this.forwardShoferEvents()

		cliLogger.debug("waiting for isReady...")
		await pWaitFor(() => this._isReady, { interval: 100, timeout: 10_000 })
		cliLogger.debug("isReady=true")
	}

	public registerWebviewProvider(_viewId: string, _provider: WebviewViewProvider): void {}

	public unregisterWebviewProvider(_viewId: string): void {}

	public markWebviewReady(): void {
		this._isReady = true

		// Apply CLI settings to the runtime config and context proxy BEFORE
		// sending webviewDidLaunch. This prevents a race condition where the
		// webviewDidLaunch handler's first-time init sync reads default state
		// (apiProvider: "anthropic") instead of the CLI-provided settings.
		setRuntimeConfigValues("openrouter", this.initialSettings as Record<string, unknown>)
		this.sendToExtension({ type: "updateSettings", updatedSettings: this.initialSettings })

		// Now trigger extension initialization. The context proxy should already
		// have CLI-provided values when the webviewDidLaunch handler runs.
		this.sendToExtension({ type: "webviewDidLaunch" })
	}

	public isInInitialSetup(): boolean {
		return !this._isReady
	}

	/**
	 * The activated `ShoferAPI` control plane.
	 *
	 * This is the single, drift-free surface for all task / configuration /
	 * profile / history / workflow operations — the exact same object companion
	 * extensions obtain from
	 * `vscode.extensions.getExtension('shoferdev.shofer').exports`. Prefer
	 * `host.api.<method>()` over adding bespoke pass-through wrappers on
	 * `ExtensionHost`; only operations that add CLI-specific behaviour (e.g.
	 * `runTask`/`resumeTask` blocking on completion) warrant a dedicated method.
	 *
	 * @throws Error if accessed before {@link activate} has resolved.
	 */
	public get api(): ShoferAPI {
		if (!this.extensionAPI) {
			throw new Error("ExtensionHost: ShoferAPI accessed before activation")
		}

		return this.extensionAPI
	}

	// ==========================================================================
	// Message Handling
	// ==========================================================================

	public sendToExtension(message: WebviewMessage): void {
		if (!this._isReady) {
			throw new Error("You cannot send messages to the extension before it is ready")
		}

		cliLogger.debug(`sendToExtension: type=${message.type}`)
		this.emit("webviewMessage", message)
	}

	// ==========================================================================
	// ShoferAPI Event Forwarding
	// ==========================================================================

	/**
	 * Subscribe to ShoferAPI events and forward them into the CLI event system.
	 * This provides richer event data (token usage, tool usage, subtask lifecycle)
	 * than the raw ExtensionMessage protocol alone.
	 *
	 * All forwarded events are emitted on `this.client.getEmitter()` so consumers
	 * that subscribe via `host.client.on(...)` see them through the same interface
	 * as native ExtensionMessage-derived events.
	 */
	private forwardShoferEvents(): void {
		if (!this.extensionAPI) {
			return
		}

		const api = this.extensionAPI
		const emitter = this.client.getEmitter()

		// ── Task lifecycle ────────────────────────────────────────

		api.on(ShoferEventName.TaskCreated, (taskId: string) => {
			emitter.emit("taskCreated", taskId)
		})

		api.on(ShoferEventName.TaskStarted, (taskId: string) => {
			emitter.emit("taskStarted", taskId)
		})

		api.on(
			ShoferEventName.TaskCompleted,
			(
				_taskId: string,
				_tokenUsage: unknown,
				_toolUsage: unknown,
				info: { rating?: string; isSubtask?: boolean } | undefined,
			) => {
				// `attempt_completion` (and the other terminal paths) declare
				// completion by emitting THIS lifecycle event plus a
				// `say:completion_result` message — they no longer issue an
				// `ask:completion_result` (see the Self-Declared Terminal State
				// Rule in AGENTS.md). The ExtensionMessage-protocol `taskCompleted`
				// guard in message-processor.ts only fires on that ask, so it never
				// fires for a fresh top-level completion. This ShoferAPI event is
				// therefore the authoritative signal that resolves
				// waitForTaskCompletion(). Subtask completions are ignored here:
				// only the root task ending should end the CLI run.
				if (info?.isSubtask) {
					return
				}

				const completedEvent: TaskCompletedEvent = {
					success: true,
					stateInfo: this.client.getAgentState(),
					message: this.client.getLastMessage(),
				}
				emitter.emit("taskCompleted", completedEvent)
			},
		)

		api.on(ShoferEventName.TaskAborted, (taskId: string, _info: unknown) => {
			emitter.emit("taskAborted", taskId)
		})

		// ── Subtask lifecycle ─────────────────────────────────────

		api.on(ShoferEventName.TaskPaused, (taskId: string) => {
			emitter.emit("taskPaused", taskId)
		})

		api.on(ShoferEventName.TaskUnpaused, (taskId: string) => {
			emitter.emit("taskUnpaused", taskId)
		})

		api.on(ShoferEventName.TaskSpawned, (_parentTaskId: string, childTaskId: string) => {
			emitter.emit("taskSpawned", childTaskId)
		})

		// ── Message events ────────────────────────────────────────

		api.on(ShoferEventName.Message, (payload: { taskId: string; action: string; message: ShoferMessage }) => {
			if (payload.message.partial) {
				return // Skip partial updates — webview bridge handles streaming
			}
			if (payload.action === "created") {
				emitter.emit("message", payload.message)
			}
		})

		api.on(ShoferEventName.QueuedMessagesUpdated, (taskId: string, queuedMessages: QueuedMessage[]) => {
			emitter.emit("queuedMessagesUpdated", { taskId, queuedMessages })
		})

		// ── Task execution ────────────────────────────────────────

		api.on(ShoferEventName.TaskModeSwitched, (_taskId: string, _mode: string) => {
			// Mode changes already tracked via the webview protocol's modeChanged event.
		})

		// ── Configuration changes ──────────────────────────────────

		api.on(ShoferEventName.ModeChanged, (newMode: string) => {
			emitter.emit("modeChanged", {
				previousMode: this.client.getCurrentMode() ?? undefined,
				currentMode: newMode,
			})
		})

		api.on(ShoferEventName.ProviderProfileChanged, (_payload: { name: string; provider: string }) => {
			// Profile changes are informational; consumers can attach directly to
			// the ShoferAPI instance if they need this level of detail.
		})

		// ── Task analytics ────────────────────────────────────────

		api.on(ShoferEventName.TaskTokenUsageUpdated, (taskId: string, _tokenUsage: unknown, _toolUsage: unknown) => {
			emitter.emit("tokenUsageUpdated", { taskId })
		})

		api.on(ShoferEventName.TaskToolFailed, (taskId: string, tool: string, error: string) => {
			emitter.emit("toolFailed", { taskId, tool, error })
		})

		cliLogger.debug("ShoferAPI event forwarding wired up")
	}

	// ==========================================================================
	// Task Management
	// ==========================================================================

	private waitForTaskCompletion(): Promise<void> {
		cliLogger.debug("waitForTaskCompletion() entered")
		return new Promise((resolve, reject) => {
			const completeHandler = () => {
				cliLogger.debug("taskCompleted event fired")
				cleanup()
				resolve()
			}

			const errorHandler = (error: Error) => {
				cliLogger.debug("error event fired", { error: error.message })
				cleanup()
				reject(error)
			}

			const cleanup = () => {
				this.client.off("taskCompleted", completeHandler)
				this.client.off("error", errorHandler)

				if (messageHandler) {
					this.client.off("message", messageHandler)
				}
			}

			// When exitOnError is enabled, listen for api_req_retry_delayed messages
			// (sent by Task.ts during auto-approval retry backoff) and exit immediately.
			let messageHandler: ((msg: ShoferMessage) => void) | null = null

			if (this.options.exitOnError) {
				messageHandler = (msg: ShoferMessage) => {
					if (msg.type === "say" && msg.say === "api_req_retry_delayed") {
						cleanup()
						reject(new Error(msg.text?.split("\n")[0] || "API request failed"))
					}
				}

				this.client.on("message", messageHandler)
			}

			this.client.once("taskCompleted", completeHandler)
			this.client.once("error", errorHandler)
		})
	}

	public async runTask(
		prompt: string,
		taskId?: string,
		configuration?: ShoferSettings,
		images?: string[],
	): Promise<void> {
		cliLogger.debug("runTask() calling api.startNewTask...")
		await this.api.startNewTask({ configuration, text: prompt, images })
		cliLogger.debug("startNewTask done, waiting for completion...")
		return this.waitForTaskCompletion()
	}

	public async resumeTask(taskId: string): Promise<void> {
		cliLogger.debug("resumeTask() calling api.resumeTask...")
		await this.api.resumeTask(taskId)
		cliLogger.debug("resumeTask done, waiting for completion...")
		return this.waitForTaskCompletion()
	}

	public async cancelTask(): Promise<void> {
		cliLogger.debug("cancelTask() calling api.cancelCurrentTask...")
		await this.api.cancelCurrentTask()
	}

	public async sendMessage(text?: string, images?: string[]): Promise<void> {
		cliLogger.debug("sendMessage() calling api.sendMessage...")
		await this.api.sendMessage(text, images)
	}

	public async approveAction(): Promise<void> {
		cliLogger.debug("approveAction() calling api.pressPrimaryButton...")
		await this.api.pressPrimaryButton()
	}

	public async rejectAction(): Promise<void> {
		cliLogger.debug("rejectAction() calling api.pressSecondaryButton...")
		await this.api.pressSecondaryButton()
	}

	// ==========================================================================
	// Public Agent State API
	// ==========================================================================

	/**
	 * Get the current agent loop state.
	 */
	public getAgentState(): AgentStateInfo {
		return this.client.getAgentState()
	}

	/**
	 * Check if the agent is currently waiting for user input.
	 */
	public isWaitingForInput(): boolean {
		return this.client.getAgentState().isWaitingForInput
	}

	// ==========================================================================
	// Cleanup
	// ==========================================================================

	async dispose(): Promise<void> {
		// Clear managers.
		this.outputManager.clear()
		this.askDispatcher.clear()

		// Remove message listener.
		if (this.messageListener) {
			this.off("extensionWebviewMessage", this.messageListener)
			this.messageListener = null
		}

		// Reset client.
		this.client.reset()

		// Deactivate extension.
		if (this.extensionModule?.deactivate) {
			try {
				await this.extensionModule.deactivate()
			} catch {
				// NO-OP
			}
		}

		// Clear references.
		this.vscode = null
		this.extensionModule = null
		this.extensionAPI = null

		// Clear globals.
		delete (global as Record<string, unknown>).vscode
		delete (global as Record<string, unknown>).__extensionHost

		// Restore console.
		this.restoreConsole()

		// Clean up ephemeral storage.
		if (this.ephemeralStorageDir) {
			try {
				await fs.promises.rm(this.ephemeralStorageDir, { recursive: true, force: true })
				this.ephemeralStorageDir = null
			} catch {
				// NO-OP
			}
		}

		// Restore previous CLI runtime marker for process hygiene in tests.
		if (this.previousCliRuntimeEnv === undefined) {
			delete process.env.ROO_CLI_RUNTIME
		} else {
			process.env.ROO_CLI_RUNTIME = this.previousCliRuntimeEnv
		}
	}
}
