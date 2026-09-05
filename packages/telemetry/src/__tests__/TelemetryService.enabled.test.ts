// Must be FIRST — hoisted above the imports so the module-level
// `const TELEMETRY_ENABLED = process.env.TELEMETRY_ENABLED === "true"` in
// TelemetryService.ts evaluates to true for this file's module registry.
vi.hoisted(() => {
	process.env.TELEMETRY_ENABLED = "true"
})

// pnpm --filter @shofer/telemetry test src/__tests__/TelemetryService.enabled.test.ts

import { ZodError, z } from "zod"

import {
	type TelemetryClient,
	type TelemetryEvent,
	type TelemetryPropertiesProvider,
	TelemetryEventName,
} from "@shofer/types"

import { BaseTelemetryClient, OtelTelemetryClient, PostHogTelemetryClient, TelemetryService } from "../index.js"

/**
 * §Telemetry Capture Rule — the typed `captureXxx` wrappers are the ONLY way an
 * event reaches a client, and each one must land the catalog event name plus its
 * documented property shape. These tests drive the whole wrapper surface through
 * a recording fake client (no PostHog, no network, no OTel SDK).
 */

/** A recording {@link TelemetryClient} — the transport seam, faked. */
class RecordingClient implements TelemetryClient {
	public readonly events: TelemetryEvent[] = []
	public readonly exceptions: Array<{ error: Error; properties?: Record<string, unknown> }> = []
	public provider: TelemetryPropertiesProvider | undefined
	public optedIn = false
	public didShutdown = false

	public setProvider(provider: TelemetryPropertiesProvider): void {
		this.provider = provider
	}

	public async capture(event: TelemetryEvent): Promise<void> {
		this.events.push(event)
	}

	public async captureException(error: Error, properties?: Record<string, unknown>): Promise<void> {
		this.exceptions.push({ error, properties })
	}

	public updateTelemetryState(isOptedIn: boolean): void {
		this.optedIn = isOptedIn
	}

	public isTelemetryEnabled(): boolean {
		return this.optedIn
	}

	public async shutdown(): Promise<void> {
		this.didShutdown = true
	}

	/** The single event captured, asserting exactly one was. */
	public get only(): TelemetryEvent {
		expect(this.events).toHaveLength(1)
		return this.events[0]!
	}
}

describe("TelemetryService (TELEMETRY_ENABLED=true)", () => {
	let client: RecordingClient
	let service: TelemetryService

	beforeEach(() => {
		client = new RecordingClient()
		service = new TelemetryService([client])
	})

	it("re-exports the client hierarchy from the package barrel", () => {
		expect(typeof TelemetryService).toBe("function")
		expect(typeof BaseTelemetryClient).toBe("function")
		expect(typeof PostHogTelemetryClient).toBe("function")
		expect(typeof OtelTelemetryClient).toBe("function")
		expect(Object.getPrototypeOf(OtelTelemetryClient)).toBe(BaseTelemetryClient)
	})

	it("reports the build flag through isGloballyEnabled()", () => {
		expect(TelemetryService.isGloballyEnabled()).toBe(true)
	})

	describe("client registration and the opt-in gate", () => {
		it("registers additional clients and fans every event out to all of them", () => {
			const second = new RecordingClient()
			service.register(second)

			service.captureTaskCreated("t1")

			expect(client.only.event).toBe(TelemetryEventName.TASK_CREATED)
			expect(second.only.event).toBe(TelemetryEventName.TASK_CREATED)
		})

		it("captures nothing while no client is registered (isReady is false)", () => {
			const empty = new TelemetryService([])
			// Nothing to assert on a client; the observable consequence is that
			// registering afterwards receives only the LATER events.
			empty.captureTaskCreated("before")
			empty.register(client)
			empty.captureTaskCreated("after")

			expect(client.only.properties).toEqual({ taskId: "after" })
		})

		it("forwards the properties provider to every client", () => {
			const provider: TelemetryPropertiesProvider = { getTelemetryProperties: vi.fn() }
			service.setProvider(provider)
			expect(client.provider).toBe(provider)
		})

		it("does not forward a provider when there is no client to forward it to", () => {
			const empty = new TelemetryService([])
			const provider: TelemetryPropertiesProvider = { getTelemetryProperties: vi.fn() }
			// Must not throw, and must not reach a client that is registered later.
			empty.setProvider(provider)
			empty.register(client)
			expect(client.provider).toBeUndefined()
		})

		it("propagates the user's TelemetrySetting to the clients", () => {
			service.updateTelemetryState(true)
			expect(client.optedIn).toBe(true)
			expect(service.isTelemetryEnabled()).toBe(true)

			service.updateTelemetryState(false)
			expect(client.optedIn).toBe(false)
			expect(service.isTelemetryEnabled()).toBe(false)
		})

		it("is not telemetry-enabled while no client is registered", () => {
			expect(new TelemetryService([]).isTelemetryEnabled()).toBe(false)
		})

		it("shuts every client down", async () => {
			await service.shutdown()
			expect(client.didShutdown).toBe(true)
		})

		it("shutdown is a no-op with no clients", async () => {
			await expect(new TelemetryService([]).shutdown()).resolves.toBeUndefined()
		})
	})

	describe("observers (§10)", () => {
		it("sees every event, before and independently of the client fan-out", () => {
			const seen: Array<[TelemetryEventName, unknown]> = []
			service.onEvent((name, props) => seen.push([name, props]))

			service.captureToolUsage("t1", "read_file")

			expect(seen).toEqual([[TelemetryEventName.TOOL_USED, { taskId: "t1", tool: "read_file" }]])
			expect(client.only.event).toBe(TelemetryEventName.TOOL_USED)
		})

		it("a throwing observer never breaks capture", () => {
			service.onEvent(() => {
				throw new Error("boom")
			})
			service.captureTaskCreated("t1")
			expect(client.only.event).toBe(TelemetryEventName.TASK_CREATED)
		})
	})

	describe("captureException", () => {
		it("forwards the error and its properties to every client", () => {
			const error = new Error("kaboom")
			service.captureException(error, { where: "test" })
			expect(client.exceptions).toEqual([{ error, properties: { where: "test" } }])
		})

		it("is a no-op with no clients", () => {
			expect(() => new TelemetryService([]).captureException(new Error("x"))).not.toThrow()
		})
	})

	describe("the typed capture wrappers", () => {
		const expectEvent = (name: TelemetryEventName, properties: Record<string, unknown>) => {
			expect(client.only.event).toBe(name)
			expect(client.only.properties).toEqual(properties)
		}

		it("captureTaskCreated", () => {
			service.captureTaskCreated("t1")
			expectEvent(TelemetryEventName.TASK_CREATED, { taskId: "t1" })
		})

		it("captureTaskRestarted", () => {
			service.captureTaskRestarted("t1")
			expectEvent(TelemetryEventName.TASK_RESTARTED, { taskId: "t1" })
		})

		it("captureTaskCompleted", () => {
			service.captureTaskCompleted("t1")
			expectEvent(TelemetryEventName.TASK_COMPLETED, { taskId: "t1" })
		})

		it("captureConversationMessage", () => {
			service.captureConversationMessage("t1", "assistant")
			expectEvent(TelemetryEventName.TASK_CONVERSATION_MESSAGE, { taskId: "t1", source: "assistant" })
		})

		it("captureLlmCompletion", () => {
			service.captureLlmCompletion("t1", {
				inputTokens: 10,
				outputTokens: 20,
				cacheWriteTokens: 1,
				cacheReadTokens: 2,
				cost: 0.5,
			})
			expectEvent(TelemetryEventName.LLM_COMPLETION, {
				taskId: "t1",
				inputTokens: 10,
				outputTokens: 20,
				cacheWriteTokens: 1,
				cacheReadTokens: 2,
				cost: 0.5,
			})
		})

		it("captureModeSwitch", () => {
			service.captureModeSwitch("t1", "architect")
			expectEvent(TelemetryEventName.MODE_SWITCH, { taskId: "t1", newMode: "architect" })
		})

		it("captureToolCallResolved records successes as well as failures", () => {
			service.captureToolCallResolved("t1", {
				modelId: "m",
				emittedName: "readFile",
				resolvedName: "read_file",
				wasAliased: true,
				wasUnknown: false,
				argKeys: ["path"],
			})
			expectEvent(TelemetryEventName.TOOL_CALL_RESOLVED, {
				taskId: "t1",
				modelId: "m",
				emittedName: "readFile",
				resolvedName: "read_file",
				wasAliased: true,
				wasUnknown: false,
				argKeys: ["path"],
			})
		})

		it("captureToolRecovery carries the layerId plus arbitrary extras", () => {
			service.captureToolRecovery("t1", { modelId: "m", layerId: "xml-leak", tool: "apply_diff", hits: 3 })
			expectEvent(TelemetryEventName.TOOL_RECOVERY_FIRED, {
				taskId: "t1",
				modelId: "m",
				layerId: "xml-leak",
				tool: "apply_diff",
				hits: 3,
			})
		})

		it("captureToolUsage", () => {
			service.captureToolUsage("t1", "write_to_file")
			expectEvent(TelemetryEventName.TOOL_USED, { taskId: "t1", tool: "write_to_file" })
		})

		it("captureContextCondensed omits usedCustomPrompt when undefined", () => {
			service.captureContextCondensed("t1", true)
			expectEvent(TelemetryEventName.CONTEXT_CONDENSED, { taskId: "t1", isAutomaticTrigger: true })
		})

		it("captureContextCondensed includes usedCustomPrompt when given (including false)", () => {
			service.captureContextCondensed("t1", false, false)
			expectEvent(TelemetryEventName.CONTEXT_CONDENSED, {
				taskId: "t1",
				isAutomaticTrigger: false,
				usedCustomPrompt: false,
			})
		})

		it("captureSlidingWindowTruncation", () => {
			service.captureSlidingWindowTruncation("t1")
			expectEvent(TelemetryEventName.SLIDING_WINDOW_TRUNCATION, { taskId: "t1" })
		})

		it("captureCodeActionUsed", () => {
			service.captureCodeActionUsed("explain")
			expectEvent(TelemetryEventName.CODE_ACTION_USED, { actionType: "explain" })
		})

		it("capturePromptEnhanced carries a taskId only when there is one", () => {
			service.capturePromptEnhanced("t1")
			expectEvent(TelemetryEventName.PROMPT_ENHANCED, { taskId: "t1" })

			client.events.length = 0
			service.capturePromptEnhanced()
			expectEvent(TelemetryEventName.PROMPT_ENHANCED, {})
		})

		it("captureSchemaValidationError formats the ZodError", () => {
			const parsed = z.object({ a: z.string() }).safeParse({ a: 1 })
			expect(parsed.success).toBe(false)
			const error = (parsed as { error: ZodError }).error

			service.captureSchemaValidationError({ schemaName: "thing", error })

			expect(client.only.event).toBe(TelemetryEventName.SCHEMA_VALIDATION_ERROR)
			expect(client.only.properties?.schemaName).toBe("thing")
			expect(client.only.properties?.error).toEqual(error.format())
		})

		it("captureDiffApplicationError", () => {
			service.captureDiffApplicationError("t1", 3)
			expectEvent(TelemetryEventName.DIFF_APPLICATION_ERROR, { taskId: "t1", consecutiveMistakeCount: 3 })
		})

		it("captureShellIntegrationError", () => {
			service.captureShellIntegrationError("t1")
			expectEvent(TelemetryEventName.SHELL_INTEGRATION_ERROR, { taskId: "t1" })
		})

		it("captureConsecutiveMistakeError", () => {
			service.captureConsecutiveMistakeError("t1")
			expectEvent(TelemetryEventName.CONSECUTIVE_MISTAKE_ERROR, { taskId: "t1" })
		})

		it("captureMcpAsyncCallStarted", () => {
			service.captureMcpAsyncCallStarted("t1", { callId: "c1", serverName: "s", toolName: "tool" })
			expectEvent(TelemetryEventName.MCP_ASYNC_CALL_STARTED, {
				taskId: "t1",
				callId: "c1",
				serverName: "s",
				toolName: "tool",
			})
		})

		it("captureMcpAsyncCallCompleted", () => {
			service.captureMcpAsyncCallCompleted("t1", {
				callId: "c1",
				serverName: "s",
				toolName: "tool",
				isError: false,
				durationMs: 42,
			})
			expectEvent(TelemetryEventName.MCP_ASYNC_CALL_COMPLETED, {
				taskId: "t1",
				callId: "c1",
				serverName: "s",
				toolName: "tool",
				isError: false,
				durationMs: 42,
			})
		})

		it("captureMcpAsyncCallCancelled", () => {
			service.captureMcpAsyncCallCancelled("t1", {
				callId: "c1",
				serverName: "s",
				toolName: "tool",
				durationMs: 7,
			})
			expectEvent(TelemetryEventName.MCP_ASYNC_CALL_CANCELLED, {
				taskId: "t1",
				callId: "c1",
				serverName: "s",
				toolName: "tool",
				durationMs: 7,
			})
		})

		it("captureMcpAsyncCallTimedOut", () => {
			service.captureMcpAsyncCallTimedOut("t1", {
				callId: "c1",
				serverName: "s",
				toolName: "tool",
				timeoutSec: 30,
			})
			expectEvent(TelemetryEventName.MCP_ASYNC_CALL_TIMED_OUT, {
				taskId: "t1",
				callId: "c1",
				serverName: "s",
				toolName: "tool",
				timeoutSec: 30,
			})
		})

		it("the four async-MCP events partition a handle's disposition", () => {
			service.captureMcpAsyncCallStarted("t1", { callId: "c1", serverName: "s", toolName: "tool" })
			service.captureMcpAsyncCallCompleted("t1", {
				callId: "c1",
				serverName: "s",
				toolName: "tool",
				isError: false,
				durationMs: 1,
			})
			service.captureMcpAsyncCallCancelled("t1", { callId: "c2", serverName: "s", toolName: "t", durationMs: 1 })
			service.captureMcpAsyncCallTimedOut("t1", { callId: "c3", serverName: "s", toolName: "t", timeoutSec: 1 })

			expect(new Set(client.events.map((e) => e.event)).size).toBe(4)
		})

		it("captureBudgetExceeded tolerates an unknown modelId", () => {
			service.captureBudgetExceeded("t1", {
				rootTaskId: "r1",
				limitUsd: 1,
				spentUsd: 2,
				action: "kill",
				modelId: undefined,
			})
			expectEvent(TelemetryEventName.BUDGET_EXCEEDED, {
				taskId: "t1",
				rootTaskId: "r1",
				limitUsd: 1,
				spentUsd: 2,
				action: "kill",
				modelId: undefined,
			})
		})

		it("captureTabShown", () => {
			service.captureTabShown("settings")
			expectEvent(TelemetryEventName.TAB_SHOWN, { tab: "settings" })
		})

		it("captureModeSettingChanged", () => {
			service.captureModeSettingChanged("customInstructions")
			expectEvent(TelemetryEventName.MODE_SETTINGS_CHANGED, { settingName: "customInstructions" })
		})

		it("captureCustomModeCreated", () => {
			service.captureCustomModeCreated("my-mode", "My Mode")
			expectEvent(TelemetryEventName.CUSTOM_MODE_CREATED, { modeSlug: "my-mode", modeName: "My Mode" })
		})

		it("captureTitleButtonClicked", () => {
			service.captureTitleButtonClicked("plus")
			expectEvent(TelemetryEventName.TITLE_BUTTON_CLICKED, { button: "plus" })
		})

		it("captureTelemetrySettingsChanged carries both sides of the toggle", () => {
			// The Telemetry Toggle Ordering Rule requires the change event to be
			// captured under the still-enabled side; the service's contract is that
			// it records BOTH settings so the direction is reconstructable.
			service.updateTelemetryState(true)
			service.captureTelemetrySettingsChanged("enabled", "disabled")
			expectEvent(TelemetryEventName.TELEMETRY_SETTINGS_CHANGED, {
				previousSetting: "enabled",
				newSetting: "disabled",
			})
		})

		it("captureMailboxSent stringifies the wake flag", () => {
			service.captureMailboxSent("t1", { kind: "request", plane: "task", wake: true })
			expectEvent(TelemetryEventName.MAILBOX_SENT, {
				taskId: "t1",
				kind: "request",
				plane: "task",
				wake: "true",
			})
		})

		it("captureMailboxDelivered stringifies the woke flag", () => {
			service.captureMailboxDelivered("t1", { kind: "reply", plane: "task", woke: false })
			expectEvent(TelemetryEventName.MAILBOX_DELIVERED, {
				taskId: "t1",
				kind: "reply",
				plane: "task",
				woke: "false",
			})
		})

		it("captureMailboxRead", () => {
			service.captureMailboxRead("t1", { count: 3 })
			expectEvent(TelemetryEventName.MAILBOX_READ, { taskId: "t1", count: 3 })
		})

		it("captureMailboxExpired", () => {
			service.captureMailboxExpired("t1", { kind: "request" })
			expectEvent(TelemetryEventName.MAILBOX_EXPIRED, { taskId: "t1", kind: "request" })
		})

		it("capturePeerDiscovery", () => {
			service.capturePeerDiscovery("t1")
			expectEvent(TelemetryEventName.TASK_PEER_DISCOVERY, { taskId: "t1" })
		})

		it("captureSubtaskSpawned carries the parent taskId and the child's mode", () => {
			service.captureSubtaskSpawned("parent", "code")
			expectEvent(TelemetryEventName.SUBTASK_SPAWNED, { taskId: "parent", mode: "code" })
		})

		it("captureTaskCancelled", () => {
			service.captureTaskCancelled("t1")
			expectEvent(TelemetryEventName.TASK_CANCELLED, { taskId: "t1" })
		})

		it("captureToolRejected", () => {
			service.captureToolRejected("t1", "execute_command")
			expectEvent(TelemetryEventName.TOOL_REJECTED, { taskId: "t1", tool: "execute_command" })
		})

		it("captureCaptchaDetected", () => {
			service.captureCaptchaDetected({ taskId: "t1", types: ["recaptcha_v2"], tabId: 7, leg: "chrome" })
			expectEvent(TelemetryEventName.CAPTCHA_DETECTED, {
				taskId: "t1",
				types: ["recaptcha_v2"],
				tabId: 7,
				leg: "chrome",
			})
		})

		it("captureCaptchaSolveAttempted", () => {
			service.captureCaptchaSolveAttempted({ taskId: "t1", type: "hcaptcha", attempt: 2, leg: "mcp" })
			expectEvent(TelemetryEventName.CAPTCHA_SOLVE_ATTEMPTED, {
				taskId: "t1",
				type: "hcaptcha",
				attempt: 2,
				leg: "mcp",
			})
		})

		it("captureCaptchaSolveCompleted", () => {
			service.captureCaptchaSolveCompleted({
				taskId: "t1",
				type: "hcaptcha",
				status: "solved",
				durationMs: 1234,
				attempts: 2,
				leg: "mcp",
			})
			expectEvent(TelemetryEventName.CAPTCHA_SOLVE_COMPLETED, {
				taskId: "t1",
				type: "hcaptcha",
				status: "solved",
				durationMs: 1234,
				attempts: 2,
				leg: "mcp",
			})
		})
	})

	describe("capturePluginEvent scrubbing (§6.11)", () => {
		it("reports the plugin and its event name as properties of one catalog event", () => {
			service.capturePluginEvent("live-memory", "index-built", { files: 12, ok: true, provider: "openai" })

			expect(client.only.event).toBe(TelemetryEventName.PLUGIN_EVENT)
			expect(client.only.properties).toEqual({
				plugin: "live-memory",
				event: "index-built",
				files: 12,
				ok: true,
				provider: "openai",
			})
		})

		it("works with no properties at all", () => {
			service.capturePluginEvent("p", "e")
			expect(client.only.properties).toEqual({ plugin: "p", event: "e" })
		})

		it("drops objects and arrays — a stack, a file's contents, a prompt", () => {
			service.capturePluginEvent("p", "e", {
				stack: { frames: ["a"] },
				files: ["/secret/path"],
				nothing: null,
				missing: undefined,
				kept: 1,
			})
			expect(client.only.properties).toEqual({ plugin: "p", event: "e", kept: 1 })
		})

		it("truncates a long string to the 256-char cap with an ellipsis", () => {
			service.capturePluginEvent("p", "e", { blob: "x".repeat(300) })
			const blob = client.only.properties?.blob as string
			expect(blob).toHaveLength(257)
			expect(blob.endsWith("…")).toBe(true)
			expect(blob.slice(0, -1)).toBe("x".repeat(256))
		})

		it("leaves a string at exactly the cap untouched", () => {
			service.capturePluginEvent("p", "e", { blob: "x".repeat(256) })
			expect(client.only.properties?.blob).toBe("x".repeat(256))
		})

		it("refuses a plugin's attempt to misattribute by shadowing the reserved keys", () => {
			service.capturePluginEvent("p", "e", { plugin: "someone-else", event: "Task Created" })
			expect(client.only.properties).toEqual({ plugin: "p", event: "e" })
		})

		it("caps how many properties ride along", () => {
			const properties = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]))
			service.capturePluginEvent("p", "e", properties)

			const { plugin, event, ...rest } = client.only.properties as Record<string, unknown>
			expect(plugin).toBe("p")
			expect(event).toBe("e")
			expect(Object.keys(rest)).toHaveLength(20)
		})
	})

	describe("the singleton", () => {
		it("throws when read before it is created", () => {
			expect(() => TelemetryService.instance).toThrow("TelemetryService not initialized")
			expect(TelemetryService.hasInstance()).toBe(false)
		})

		it("creates once, keeps the clients when the build flag is on, and refuses a second creation", () => {
			const created = TelemetryService.createInstance([client])
			expect(TelemetryService.hasInstance()).toBe(true)
			expect(TelemetryService.instance).toBe(created)

			created.captureTaskCreated("t1")
			expect(client.only.event).toBe(TelemetryEventName.TASK_CREATED)

			expect(() => TelemetryService.createInstance([])).toThrow("TelemetryService instance already created")
		})
	})
})
