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
	ShoferExtensionApi,
	QueuedMessage,
} from "@shofer/types"
import { ShoferEventName } from "@shofer/types"
import { createVSCodeAPI, IExtensionHost, ExtensionHostEventMap, setRuntimeConfigValues } from "@shofer/vscode-shim"
import { DebugLogger, setDebugLogEnabled } from "@shofer/core/cli"

import { DEFAULT_FLAGS, type SupportedProvider } from "@/types/index.js"
import type { User } from "@/lib/sdk/index.js"
import { getProviderSettings } from "@/lib/utils/provider.js"
import { createEphemeralStorageDir } from "@/lib/storage/index.js"

import {
	applyConfiguredApprovalPosture,
	defaultApprovalSeed,
	resolveApprovalPosture,
	resolveCliScopeRoots,
	type ApprovalPosture,
} from "./approval-posture.js"
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
	 * When true, a driving controller brokers interactive asks (approval +
	 * followup) to a remote user over the transport, so the local AskDispatcher
	 * leaves them outstanding instead of prompting/auto-answering. Set on a headless
	 * `shofer serve` node — it has no local stdin user. Idle / flow-control asks are
	 * still handled locally.
	 */
	brokerInteractiveAsks?: boolean
	/**
	 * The approval posture this host seeds for keys its `.shofer/` scopes do not
	 * supply. Defaults to {@link defaultApprovalSeed} — auto-approve nothing.
	 *
	 * A command passes {@link unattendedApprovalSeed} here when the person who
	 * invoked it asked for an unattended run, which is what keeps the grant
	 * attributable: a served node never gets one, because nobody stated it.
	 */
	approvalSeed?: Partial<ShoferSettings>
	/**
	 * When true, uses a temporary storage directory that is cleaned up on exit.
	 */
	ephemeral: boolean
	/**
	 * Where this host keeps its own state — task store, global state, machine id
	 * (defaults to `$HOME/.vscode-mock`).
	 *
	 * Set it when several hosts share a filesystem, which is exactly the shape a pool of
	 * headless hosts has: N pods mounting one volume. The state store is SQLite, so pods
	 * sharing one directory would be N writers on one database; each pod needs its own.
	 * Ignored when {@link ephemeral} is set — that already implies a private dir.
	 */
	storageDir?: string
	debug: boolean
	exitOnComplete: boolean
	terminalShell?: string
	/**
	 * When true, exit the process on API request errors instead of retrying.
	 */
	exitOnError?: boolean
	/**
	 * Number of times to auto-resume an interrupted task in non-interactive
	 * mode. Defaults to 0 (do not auto-resume; terminate the run instead).
	 */
	retry?: number
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
	/** §12 ACP — drive the activated ShoferExtensionApi over the Agent Client Protocol on stdio. */
	runAcpAgentOverShoferApi?: (
		api: unknown,
		streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; agentVersion?: string },
	) => Promise<void>
	/** §11 — start the HTTP/SSE server over the activated ShoferExtensionApi. Returns the node
	 *  `http.Server` so the caller can await `listening`/`error` before reporting success. */
	serveHttpOverShoferApi?: (
		api: unknown,
		opts: { port: number; host?: string; token?: string; version?: string },
	) => import("node:http").Server
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
	grantResume(): void
	setAskDispatcherEnabled(enabled: boolean): void
	sendToExtension(message: WebviewMessage): void
	dispose(): Promise<void>
}

export class ExtensionHost extends EventEmitter implements ExtensionHostInterface {
	// Extension lifecycle.
	private vscode: ReturnType<typeof createVSCodeAPI> | null = null
	private extensionModule: ExtensionModule | null = null
	private extensionAPI: ShoferExtensionApi | null = null
	private options: ExtensionHostOptions
	private _isReady = false
	private messageListener: ((message: ExtensionMessage) => void) | null = null
	private initialSettings: ShoferSettings
	private _approvalPosture: ApprovalPosture

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

	/**
	 * Set while {@link waitForTaskCompletion} is pending. Invoked by the
	 * AskDispatcher when it declines to auto-resume an interrupted task (the
	 * `--retry` budget is exhausted) so the pending task promise settles and the
	 * run terminates cleanly instead of hanging on the unanswered resume ask.
	 */
	private onResumeDeclined?: () => void

	// ==========================================================================
	// Constructor
	// ==========================================================================

	constructor(options: ExtensionHostOptions) {
		super()

		this.options = options
		// Mark this process as CLI runtime so extension code can apply
		// CLI-specific behavior without affecting VS Code desktop usage.
		this.previousCliRuntimeEnv = process.env.SHOFER_CLI_RUNTIME
		process.env.SHOFER_CLI_RUNTIME = "1"

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
			brokerInteractiveAsks: options.brokerInteractiveAsks,
			exitOnError: options.exitOnError,
			maxResumeRetries: options.retry ?? 0,
			onResumeDeclined: () => this.onResumeDeclined?.(),
			disabled: options.disableOutput, // TUI mode handles asks directly.
		})

		// Wire up client events.
		this.setupClientEventHandlers()

		// Populate initial settings.
		const baseSettings: ShoferSettings = {
			mode: this.options.mode,
			consecutiveMistakeLimit: this.options.consecutiveMistakeLimit ?? DEFAULT_FLAGS.consecutiveMistakeLimit,
			commandExecutionTimeout: 300,
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

		// The approval posture starts as this host's seed — by default the master
		// gate off and nothing auto-approved — and is narrowed or widened in
		// `activate()` by whatever the node's own `.shofer/` config supplies. See
		// `approval-posture.ts` for why an absent key denies, and why configuration
		// takes effect by OMISSION from the seed rather than by overriding it. Until
		// that runs (and for hosts that never call `activate()`), the seed is the
		// posture.
		const seed = this.approvalSeed()
		this.initialSettings = { ...seed, ...baseSettings }
		this._approvalPosture = applyConfiguredApprovalPosture(seed, {})

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

		let storageDir: string | undefined = this.options.storageDir

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

		// Resolve the approval posture BEFORE the extension bundle loads. The seed is
		// delivered from `markWebviewReady()`, which the shim calls synchronously once
		// the extension resolves its webview — there is no await point there, so the
		// (async) config read must already have happened. Doing it here, right after the
		// mock context exists, also means the scope roots are derived from the very
		// context `ContextProxy` will later resolve its own from.
		await this.applyApprovalPostureFromConfig()

		// Write a real vscode-mock.js file to a temp directory so Node can
		// physically resolve it. In-memory cache entries and _load monkey-patches
		// do not survive the ESM loader used by tsx — only a real on-disk file
		// works reliably across both CJS and ESM module resolution paths.
		// Under the workspace only when this host has no private state dir: hosts that
		// share a workspace (a pool) would otherwise race each other rewriting one file.
		const mockDir =
			this.ephemeralStorageDir ??
			this.options.storageDir ??
			path.join(this.options.workspacePath, ".shofer", "tmp")
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
			this.extensionAPI = (await this.extensionModule.activate(this.vscode.context)) as ShoferExtensionApi
			cliLogger.debug("extension activated")
		} catch (error) {
			throw new Error(`Failed to activate extension: ${error instanceof Error ? error.message : String(error)}`)
		}

		// Set up message listener - forward all messages to client.
		this.messageListener = (message: ExtensionMessage) => this.client.handleMessage(message)
		this.on("extensionWebviewMessage", this.messageListener)

		// Forward ShoferExtensionApi events to complement the webview-message-based event stream.
		this.forwardShoferEvents()

		cliLogger.debug("waiting for isReady...")
		await pWaitFor(() => this._isReady, { interval: 100, timeout: 10_000 })
		cliLogger.debug("isReady=true")
	}

	/**
	 * The posture this host will actually run with, and where it came from. Read by
	 * `shofer serve` for its startup banner so a node whose approvals come from
	 * configuration never looks, in its logs, like one running the built-in default.
	 *
	 * Meaningful only after {@link activate}; before that it reports the seed.
	 */
	public get approvalPosture(): ApprovalPosture {
		return this._approvalPosture
	}

	/**
	 * This host's approval seed: whatever the invoking command stated, else the
	 * built-in default, which auto-approves nothing. One accessor so the
	 * constructor's provisional posture and `activate()`'s resolved one cannot
	 * disagree about what the node would run with when its config says nothing.
	 */
	private approvalSeed(): Partial<ShoferSettings> {
		return this.options.approvalSeed ?? defaultApprovalSeed()
	}

	/**
	 * Fold the node's own layered `.shofer/` configuration into the seeded approval
	 * posture, then **drop** from {@link initialSettings} every posture key the
	 * config supplies.
	 *
	 * Dropping — rather than overwriting the seed with the config value — is the
	 * point: `ContextProxy` serves the layered overlay ahead of `globalState`, so a
	 * seeded value for a configured key would be shadowed on read *and* would be
	 * written through into the operator's own `settings.json` on the way. See
	 * `approval-posture.ts` for the full reasoning.
	 *
	 * Never throws: a config that cannot be read leaves the seed in place, so the
	 * node asks for everything rather than guessing at a posture it could not read.
	 */
	private async applyApprovalPostureFromConfig(): Promise<void> {
		const roots = resolveCliScopeRoots({
			globalStorageFsPath: this.vscode?.context?.globalStorageUri?.fsPath,
			workspacePath: this.options.workspacePath,
		})

		this._approvalPosture = await resolveApprovalPosture({ roots, seed: this.approvalSeed() })

		for (const key of this._approvalPosture.configuredKeys) {
			delete this.initialSettings[key]
		}

		if (this._approvalPosture.configuredKeys.length > 0) {
			cliLogger.debug("approval posture from .shofer config", {
				keys: this._approvalPosture.configuredKeys,
				summary: this._approvalPosture.summary,
			})
		}
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
	 * The activated `ShoferExtensionApi` control plane.
	 *
	 * This is the single, drift-free surface for all task / configuration /
	 * profile / history operations — the exact same object companion
	 * extensions obtain from
	 * `vscode.extensions.getExtension('shoferdev.shofer').exports`. Prefer
	 * `host.api.<method>()` over adding bespoke pass-through wrappers on
	 * `ExtensionHost`; only operations that add CLI-specific behaviour (e.g.
	 * `runTask`/`resumeTask` blocking on completion) warrant a dedicated method.
	 *
	 * @throws Error if accessed before {@link activate} has resolved.
	 */
	public get api(): ShoferExtensionApi {
		if (!this.extensionAPI) {
			throw new Error("ExtensionHost: ShoferExtensionApi accessed before activation")
		}

		return this.extensionAPI
	}

	/**
	 * §12 ACP — run the Agent Client Protocol server over the given streams,
	 * driving the activated `ShoferExtensionApi`. Resolves when the input stream closes.
	 */
	public runAcp(streams: {
		input: NodeJS.ReadableStream
		output: NodeJS.WritableStream
		agentVersion?: string
	}): Promise<void> {
		const run = this.extensionModule?.runAcpAgentOverShoferApi
		if (!run) {
			throw new Error("ExtensionHost: this extension bundle does not export runAcpAgentOverShoferApi")
		}
		return run(this.api, streams)
	}

	/**
	 * §11 — start the HTTP/SSE server over the activated `ShoferExtensionApi`. Returns a
	 * handle whose `close()` stops the server.
	 */
	public serve(opts: {
		port: number
		host?: string
		token?: string
		version?: string
		/** Honor the controller's per-task API Configuration (no local CLI override). */
		allowClientConfig?: boolean
	}): import("node:http").Server {
		const serve = this.extensionModule?.serveHttpOverShoferApi
		if (!serve) {
			throw new Error("ExtensionHost: this extension bundle does not export serveHttpOverShoferApi")
		}
		return serve(this.api, opts)
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
	// ShoferExtensionApi Event Forwarding
	// ==========================================================================

	/**
	 * Subscribe to ShoferExtensionApi events and forward them into the CLI event system.
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
				// fires for a fresh top-level completion. This ShoferExtensionApi event is
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
			// the ShoferExtensionApi instance if they need this level of detail.
		})

		// ── Task analytics ────────────────────────────────────────

		api.on(ShoferEventName.TaskTokenUsageUpdated, (taskId: string, _tokenUsage: unknown, _toolUsage: unknown) => {
			emitter.emit("tokenUsageUpdated", { taskId })
		})

		api.on(ShoferEventName.TaskToolFailed, (taskId: string, tool: string, error: string) => {
			emitter.emit("toolFailed", { taskId, tool, error })
		})

		cliLogger.debug("ShoferExtensionApi event forwarding wired up")
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

				this.onResumeDeclined = undefined
			}

			// When the AskDispatcher declines to auto-resume an interrupted task
			// (the `--retry` budget is exhausted), settle this promise as a failure
			// so the run terminates cleanly via run.ts' catch path instead of
			// hanging on the unanswered resume_task ask.
			this.onResumeDeclined = () => {
				cliLogger.debug("resume declined; auto-resume budget exhausted")
				cleanup()
				reject(new Error("Task interrupted; not auto-resuming (use --retry <n> to enable)"))
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
		cliLogger.debug("runTask() calling api.createTask...")
		await this.api.createTask({ configuration, prompt, images, taskId })
		cliLogger.debug("createTask done, waiting for completion...")
		return this.waitForTaskCompletion()
	}

	public async resumeTask(taskId: string): Promise<void> {
		cliLogger.debug("resumeTask() calling api.resumeTask...")
		// An explicit resume (e.g. `--resume <session>`) must always be honored
		// once, independent of the `--retry` auto-resume budget which governs only
		// the repeated resumes that would otherwise loop on a recurring interrupt.
		this.askDispatcher.grantResume()
		await this.api.resumeTask(taskId)
		cliLogger.debug("resumeTask done, waiting for completion...")
		return this.waitForTaskCompletion()
	}

	public async cancelTask(taskId?: string): Promise<void> {
		const target = taskId ?? this.api.getCurrentTaskStack().at(-1)
		if (!target) {
			cliLogger.debug("cancelTask() dropped: no current task")
			return
		}
		cliLogger.debug("cancelTask() calling api.cancelTask...")
		await this.api.cancelTask(target)
	}

	public async sendMessage(text?: string, images?: string[], taskId?: string): Promise<void> {
		// `taskId` defaults to the current task for callers that track no ids (the
		// TUI); the API call underneath is always task-addressed.
		const target = taskId ?? this.api.getCurrentTaskStack().at(-1)
		if (!target) {
			cliLogger.debug("sendMessage() dropped: no current task")
			return
		}
		cliLogger.debug("sendMessage() calling api.sendMessage...")
		await this.api.sendMessage(target, text ?? "", images)
	}

	/**
	 * Approve / reject the addressed task's outstanding ask. The old
	 * `pressPrimaryButton`/`pressSecondaryButton` pair simulated a webview click on
	 * whatever task happened to be current; answering the ask directly is the same
	 * action without the current-task guess.
	 */
	public async approveAction(): Promise<void> {
		await this.answerAsk("yesButtonClicked")
	}

	public async rejectAction(): Promise<void> {
		await this.answerAsk("noButtonClicked")
	}

	/**
	 * Answer a task's outstanding ask — `ShoferApi.respondToAsk`. `taskId`
	 * defaults to the current task so a caller that tracks no ids (the TUI, a
	 * stdin driver addressing its only task) still reaches the right one; the
	 * API call underneath is always task-addressed.
	 */
	public async respondToAsk(
		response: { askResponse: string; text?: string; images?: string[]; askId?: string; mode?: string },
		taskId?: string,
	): Promise<void> {
		const target = taskId ?? this.api.getCurrentTaskStack().at(-1)
		if (!target) {
			cliLogger.debug(`respondToAsk(${response.askResponse}) dropped: no current task`)
			return
		}
		await this.api.respondToAsk(target, response)
	}

	private async answerAsk(askResponse: "yesButtonClicked" | "noButtonClicked"): Promise<void> {
		const taskId = this.api.getCurrentTaskStack().at(-1)
		if (!taskId) {
			cliLogger.debug(`${askResponse} dropped: no current task`)
			return
		}
		cliLogger.debug(`answerAsk() calling api.respondToAsk(${askResponse})...`)
		await this.api.respondToAsk(taskId, { askResponse })
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

	public grantResume(): void {
		this.askDispatcher.grantResume()
	}

	public setAskDispatcherEnabled(enabled: boolean): void {
		this.askDispatcher.setDisabled(!enabled)
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
			delete process.env.SHOFER_CLI_RUNTIME
		} else {
			process.env.SHOFER_CLI_RUNTIME = this.previousCliRuntimeEnv
		}
	}
}
