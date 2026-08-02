import { ZodError } from "zod"

import {
	type TelemetryClient,
	type TelemetryPropertiesProvider,
	TelemetryEventName,
	type TelemetrySetting,
} from "@shofer/types"

/**
 * Environment variable to globally enable/disable all telemetry.
 * Set TELEMETRY_ENABLED=true to send telemetry data to backends
 * (PostHog, Shofer Cloud, etc.). Defaults to false — no telemetry
 * is sent unless explicitly enabled. No server-side infrastructure
 * is required when telemetry is disabled (the default).
 */
const TELEMETRY_ENABLED = process.env.TELEMETRY_ENABLED === "true"

/** Caps on what a plugin may attach to an event (see {@link TelemetryService.capturePluginEvent}). */
const PLUGIN_PROPERTY_LIMIT = 20
const PLUGIN_STRING_LIMIT = 256

/**
 * Reduce a plugin's event properties to something safe to send off the machine.
 *
 * Keeps primitives (a count, a provider name, a duration), truncates long strings, and
 * drops objects and arrays outright — an error's `stack`, a file's contents or a prompt
 * would otherwise reach the telemetry backend because a plugin author spread an object
 * into the call. Reserved keys (`plugin`, `event`) are dropped so a plugin cannot
 * misattribute its own events.
 */
function scrubPluginProperties(properties?: Record<string, unknown>): Record<string, string | number | boolean> {
	if (!properties) return {}
	const out: Record<string, string | number | boolean> = {}
	for (const [key, value] of Object.entries(properties)) {
		if (Object.keys(out).length >= PLUGIN_PROPERTY_LIMIT) break
		if (key === "plugin" || key === "event") continue
		if (typeof value === "number" || typeof value === "boolean") {
			out[key] = value
		} else if (typeof value === "string") {
			out[key] = value.length > PLUGIN_STRING_LIMIT ? `${value.slice(0, PLUGIN_STRING_LIMIT)}…` : value
		}
	}
	return out
}

/**
 * TelemetryService wrapper class that defers initialization.
 * This ensures that we only create the various clients after environment
 * variables are loaded.
 */
export class TelemetryService {
	constructor(private clients: TelemetryClient[]) {}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private eventObservers: Array<(eventName: TelemetryEventName, properties?: Record<string, any>) => void> = []

	public register(client: TelemetryClient): void {
		if (!TELEMETRY_ENABLED) {
			return
		}
		this.clients.push(client)
	}

	/**
	 * Observe every captured event (independent of the telemetry opt-in gate). Used
	 * to fan agent events out to consumers like the plugin registry (§10) without
	 * coupling telemetry to them. Returns an unsubscribe fn.
	 */
	public onEvent(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		observer: (eventName: TelemetryEventName, properties?: Record<string, any>) => void,
	): () => void {
		this.eventObservers.push(observer)
		return () => {
			this.eventObservers = this.eventObservers.filter((o) => o !== observer)
		}
	}

	/**
	 * Sets the ShoferProvider reference to use for global properties
	 * @param provider A ShoferProvider instance to use
	 */
	public setProvider(provider: TelemetryPropertiesProvider): void {
		if (!TELEMETRY_ENABLED) {
			return
		}
		// If client is initialized, pass the provider reference.
		if (this.isReady) {
			this.clients.forEach((client) => client.setProvider(provider))
		}
	}

	/**
	 * Base method for all telemetry operations
	 * Checks if the service is initialized before performing any operation
	 * @returns Whether the service is ready to use
	 */
	private get isReady(): boolean {
		return TELEMETRY_ENABLED && this.clients.length > 0
	}

	/**
	 * Updates the telemetry state based on user preferences and VSCode settings
	 * @param isOptedIn Whether the user is opted into telemetry
	 */
	public updateTelemetryState(isOptedIn: boolean): void {
		if (!this.isReady) {
			return
		}

		this.clients.forEach((client) => client.updateTelemetryState(isOptedIn))
	}

	/**
	 * Generic method to capture any type of event with specified properties
	 * @param eventName The event name to capture
	 * @param properties The event properties
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	public captureEvent(eventName: TelemetryEventName, properties?: Record<string, any>): void {
		// Fan out to observers (e.g. the plugin registry) regardless of the telemetry
		// opt-in — plugins should see agent events even when telemetry is off.
		for (const observer of this.eventObservers) {
			try {
				observer(eventName, properties)
			} catch {
				// An observer must never break event capture.
			}
		}

		if (!this.isReady) {
			return
		}

		this.clients.forEach((client) => client.capture({ event: eventName, properties }))
	}

	/**
	 * Captures an exception using PostHog's error tracking
	 * @param error The error to capture
	 * @param additionalProperties Additional properties to include with the exception
	 */
	public captureException(error: Error, additionalProperties?: Record<string, unknown>): void {
		if (!this.isReady) {
			return
		}

		this.clients.forEach((client) => client.captureException(error, additionalProperties))
	}

	public captureTaskCreated(taskId: string): void {
		this.captureEvent(TelemetryEventName.TASK_CREATED, { taskId })
	}

	public captureTaskRestarted(taskId: string): void {
		this.captureEvent(TelemetryEventName.TASK_RESTARTED, { taskId })
	}

	public captureTaskCompleted(taskId: string): void {
		this.captureEvent(TelemetryEventName.TASK_COMPLETED, { taskId })
	}

	public captureConversationMessage(taskId: string, source: "user" | "assistant"): void {
		this.captureEvent(TelemetryEventName.TASK_CONVERSATION_MESSAGE, { taskId, source })
	}

	public captureLlmCompletion(
		taskId: string,
		properties: {
			inputTokens: number
			outputTokens: number
			cacheWriteTokens: number
			cacheReadTokens: number
			cost?: number
		},
	): void {
		this.captureEvent(TelemetryEventName.LLM_COMPLETION, { taskId, ...properties })
	}

	public captureModeSwitch(taskId: string, newMode: string): void {
		this.captureEvent(TelemetryEventName.MODE_SWITCH, { taskId, newMode })
	}

	/**
	 * Records the outcome of parsing a single native tool call. Fires on EVERY
	 * call — successful canonical names, silent alias/dialect resolutions, and
	 * unknown-tool failures alike — so the actual per-model dialect distribution
	 * and alias hit-rates are measurable. Logging successes (not just failures) is
	 * essential: once an alias exists, the foreign form succeeds silently and
	 * failure-only metrics go blind to a real model preference.
	 */
	public captureToolCallResolved(
		taskId: string,
		properties: {
			modelId: string
			emittedName: string
			resolvedName?: string
			wasAliased: boolean
			wasUnknown: boolean
			argKeys?: string[]
		},
	): void {
		this.captureEvent(TelemetryEventName.TOOL_CALL_RESOLVED, { taskId, ...properties })
	}

	/**
	 * Records that a silent recovery layer fired (e.g. apply_diff XML-leak path
	 * recovery). `layerId` identifies the layer so its hit-rate and correctness can
	 * be tracked and zero-hit / low-correctness layers retired — the removal loop
	 * that lets the next defensive patch be safe to add because it can be removed.
	 */
	public captureToolRecovery(
		taskId: string,
		properties: {
			modelId: string
			layerId: string
			tool: string
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			[key: string]: any
		},
	): void {
		this.captureEvent(TelemetryEventName.TOOL_RECOVERY_FIRED, { taskId, ...properties })
	}

	public captureToolUsage(taskId: string, tool: string): void {
		this.captureEvent(TelemetryEventName.TOOL_USED, { taskId, tool })
	}

	public captureContextCondensed(taskId: string, isAutomaticTrigger: boolean, usedCustomPrompt?: boolean): void {
		this.captureEvent(TelemetryEventName.CONTEXT_CONDENSED, {
			taskId,
			isAutomaticTrigger,
			...(usedCustomPrompt !== undefined && { usedCustomPrompt }),
		})
	}

	public captureSlidingWindowTruncation(taskId: string): void {
		this.captureEvent(TelemetryEventName.SLIDING_WINDOW_TRUNCATION, { taskId })
	}

	public captureCodeActionUsed(actionType: string): void {
		this.captureEvent(TelemetryEventName.CODE_ACTION_USED, { actionType })
	}

	public capturePromptEnhanced(taskId?: string): void {
		this.captureEvent(TelemetryEventName.PROMPT_ENHANCED, { ...(taskId && { taskId }) })
	}

	public captureSchemaValidationError({ schemaName, error }: { schemaName: string; error: ZodError }): void {
		// https://zod.dev/ERROR_HANDLING?id=formatting-errors
		this.captureEvent(TelemetryEventName.SCHEMA_VALIDATION_ERROR, { schemaName, error: error.format() })
	}

	public captureDiffApplicationError(taskId: string, consecutiveMistakeCount: number): void {
		this.captureEvent(TelemetryEventName.DIFF_APPLICATION_ERROR, { taskId, consecutiveMistakeCount })
	}

	public captureShellIntegrationError(taskId: string): void {
		this.captureEvent(TelemetryEventName.SHELL_INTEGRATION_ERROR, { taskId })
	}

	public captureConsecutiveMistakeError(taskId: string): void {
		this.captureEvent(TelemetryEventName.CONSECUTIVE_MISTAKE_ERROR, { taskId })
	}

	/**
	 * Captures lifecycle events for an async MCP tool call dispatched via
	 * `call_mcp_tool_async`. The four events form a partition of every
	 * handle's terminal disposition: a call ends in exactly one of
	 * completed / cancelled / timed-out, after starting exactly once.
	 */
	public captureMcpAsyncCallStarted(
		taskId: string,
		properties: { callId: string; serverName: string; toolName: string },
	): void {
		this.captureEvent(TelemetryEventName.MCP_ASYNC_CALL_STARTED, { taskId, ...properties })
	}

	public captureMcpAsyncCallCompleted(
		taskId: string,
		properties: { callId: string; serverName: string; toolName: string; isError: boolean; durationMs: number },
	): void {
		this.captureEvent(TelemetryEventName.MCP_ASYNC_CALL_COMPLETED, { taskId, ...properties })
	}

	public captureMcpAsyncCallCancelled(
		taskId: string,
		properties: { callId: string; serverName: string; toolName: string; durationMs: number },
	): void {
		this.captureEvent(TelemetryEventName.MCP_ASYNC_CALL_CANCELLED, { taskId, ...properties })
	}

	public captureMcpAsyncCallTimedOut(
		taskId: string,
		properties: { callId: string; serverName: string; toolName: string; timeoutSec: number },
	): void {
		this.captureEvent(TelemetryEventName.MCP_ASYNC_CALL_TIMED_OUT, { taskId, ...properties })
	}

	/**
	 * Captures when a task's cost limit has been exceeded.
	 * Emitted before the limit action (pause/abort/kill) is taken.
	 */
	public captureBudgetExceeded(
		taskId: string,
		properties: {
			rootTaskId: string
			limitUsd: number
			spentUsd: number
			action: string
			modelId: string | undefined
		},
	): void {
		this.captureEvent(TelemetryEventName.BUDGET_EXCEEDED, { taskId, ...properties })
	}

	/**
	 * Captures when a tab is shown due to user action
	 * @param tab The tab that was shown
	 */
	public captureTabShown(tab: string): void {
		this.captureEvent(TelemetryEventName.TAB_SHOWN, { tab })
	}

	/**
	 * Captures when a setting is changed in ModesView
	 * @param settingName The name of the setting that was changed
	 */
	public captureModeSettingChanged(settingName: string): void {
		this.captureEvent(TelemetryEventName.MODE_SETTINGS_CHANGED, { settingName })
	}

	/**
	 * Captures when a user creates a new custom mode
	 * @param modeSlug The slug of the custom mode
	 * @param modeName The name of the custom mode
	 */
	public captureCustomModeCreated(modeSlug: string, modeName: string): void {
		this.captureEvent(TelemetryEventName.CUSTOM_MODE_CREATED, { modeSlug, modeName })
	}

	/**
	 * Captures a title button click event
	 * @param button The button that was clicked
	 */
	public captureTitleButtonClicked(button: string): void {
		this.captureEvent(TelemetryEventName.TITLE_BUTTON_CLICKED, { button })
	}

	/**
	 * Captures when telemetry settings are changed
	 * @param previousSetting The previous telemetry setting
	 * @param newSetting The new telemetry setting
	 */
	public captureTelemetrySettingsChanged(previousSetting: TelemetrySetting, newSetting: TelemetrySetting): void {
		this.captureEvent(TelemetryEventName.TELEMETRY_SETTINGS_CHANGED, {
			previousSetting,
			newSetting,
		})
	}

	/**
	 * Checks if telemetry is currently enabled
	 * @returns Whether telemetry is enabled
	 */
	public isTelemetryEnabled(): boolean {
		if (!TELEMETRY_ENABLED) {
			return false
		}
		return this.isReady && this.clients.some((client) => client.isTelemetryEnabled())
	}

	/**
	 * Returns whether telemetry has been globally enabled via the
	 * TELEMETRY_ENABLED environment variable.
	 */
	public static isGloballyEnabled(): boolean {
		return TELEMETRY_ENABLED
	}

	/**
	 * Captures per-batch segment deduplication stats from the code-index
	 * file watcher so we can verify the per-segment dedup optimization
	 * in production.
	 *
	 * Aggregated across all files in a single batch to keep cardinality
	 * bounded and avoid leaking individual file paths to telemetry.
	 */
	public capturePeerMessageSent(taskId: string, properties?: Record<string, string | number>): void {
		this.captureEvent(TelemetryEventName.TASK_PEER_MESSAGE_SENT, { taskId, ...properties })
	}

	public capturePeerMessageReceived(taskId: string, properties?: Record<string, string | number>): void {
		this.captureEvent(TelemetryEventName.TASK_PEER_MESSAGE_RECEIVED, { taskId, ...properties })
	}

	public capturePeerDiscovery(taskId: string): void {
		this.captureEvent(TelemetryEventName.TASK_PEER_DISCOVERY, { taskId })
	}

	/** A subtask (`new_task`) was spawned. `taskId` is the parent task. */
	public captureSubtaskSpawned(taskId: string, mode: string, isBackground: boolean): void {
		this.captureEvent(TelemetryEventName.SUBTASK_SPAWNED, { taskId, mode, isBackground })
	}

	/** A task was cancelled (e.g. via `cancel_tasks` or user abort). */
	public captureTaskCancelled(taskId: string): void {
		this.captureEvent(TelemetryEventName.TASK_CANCELLED, { taskId })
	}

	/** The user rejected a tool's approval prompt. */
	public captureToolRejected(taskId: string, tool: string): void {
		this.captureEvent(TelemetryEventName.TOOL_REJECTED, { taskId, tool })
	}

	/**
	 * An event a **plugin** reported through `ctx.host.telemetry` (design §6.11).
	 *
	 * Plugins do not get to name top-level events — the catalog is core's — so everything
	 * they report arrives as {@link TelemetryEventName.PLUGIN_EVENT} with the plugin and
	 * its own event name as properties. A query filters on `plugin`/`event`; a plugin can
	 * neither shadow a core event nor make one up.
	 *
	 * Properties are **scrubbed** on the way in: primitives only, strings truncated, and a
	 * hard cap on how many there are. A plugin sees workspace content — file paths, code,
	 * prompts — and telemetry leaves the machine, so the boundary refuses to carry a blob
	 * rather than trusting each plugin author to remember that.
	 */
	public capturePluginEvent(plugin: string, event: string, properties?: Record<string, unknown>): void {
		this.captureEvent(TelemetryEventName.PLUGIN_EVENT, {
			plugin,
			event,
			...scrubPluginProperties(properties),
		})
	}

	// ─── Captcha Solver ───────────────────────────────────────────────────
	// See extensions/docs/captcha-solver.md for the full design. These events
	// track detection (browser_detect_captcha) and the solver sub-task's
	// attempt/round lifecycle. `leg` is "mcp" (headless/Playwright) or "chrome"
	// (Chrome-extension CDP).

	/** browser_detect_captcha found ≥1 captcha widget on the page. */
	public captureCaptchaDetected(properties: {
		taskId: string
		/** Detected captcha type(s), e.g. "recaptcha_v2", "hcaptcha". */
		types: string[]
		tabId?: number
		leg: "mcp" | "chrome"
	}): void {
		this.captureEvent(TelemetryEventName.CAPTCHA_DETECTED, properties)
	}

	/** The solver sub-task began a solve attempt. */
	public captureCaptchaSolveAttempted(properties: {
		taskId: string
		type: string
		attempt: number
		leg: "mcp" | "chrome"
	}): void {
		this.captureEvent(TelemetryEventName.CAPTCHA_SOLVE_ATTEMPTED, properties)
	}

	/** The solver finished — solved, failed, or unsolvable. */
	public captureCaptchaSolveCompleted(properties: {
		taskId: string
		type: string
		status: "solved" | "failed" | "unsolvable"
		durationMs: number
		attempts: number
		leg: "mcp" | "chrome"
	}): void {
		this.captureEvent(TelemetryEventName.CAPTCHA_SOLVE_COMPLETED, properties)
	}

	public async shutdown(): Promise<void> {
		if (!this.isReady) {
			return
		}

		this.clients.forEach((client) => client.shutdown())
	}

	private static _instance: TelemetryService | null = null

	static createInstance(clients: TelemetryClient[] = []) {
		if (this._instance) {
			throw new Error("TelemetryService instance already created")
		}

		this._instance = new TelemetryService(TELEMETRY_ENABLED ? clients : [])
		return this._instance
	}

	static get instance() {
		if (!this._instance) {
			throw new Error("TelemetryService not initialized")
		}

		return this._instance
	}

	static hasInstance(): boolean {
		return this._instance !== null
	}
}
