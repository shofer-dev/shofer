// Must be FIRST — hoisted above the imports so the module-level
// `const TELEMETRY_ENABLED = process.env.TELEMETRY_ENABLED === "true"` in
// PostHogTelemetryClient.ts evaluates to true.
vi.hoisted(() => {
	process.env.TELEMETRY_ENABLED = "true"
})

/* eslint-disable @typescript-eslint/no-explicit-any */

// pnpm --filter @shofer/telemetry test src/__tests__/PostHogTelemetryClient.debug.test.ts

import { PostHog } from "posthog-node"

import {
	type TelemetryPropertiesProvider,
	ConsecutiveMistakeError,
	TelemetryEventName,
	setHost,
	createInMemoryHost,
} from "@shofer/types"

import { PostHogTelemetryClient } from "../PostHogTelemetryClient.js"

vi.mock("posthog-node")

/**
 * The debug-logging arm of the PostHog transport plus the two error paths its
 * main suite does not reach: a `ConsecutiveMistakeError`'s auto-extracted
 * properties, and a properties provider that throws while an exception is being
 * captured (which must not lose the exception).
 */
describe("PostHogTelemetryClient — debug logging and error extraction", () => {
	let mockPostHogClient: any
	let info: any

	beforeEach(() => {
		vi.clearAllMocks()

		mockPostHogClient = {
			capture: vi.fn(),
			captureException: vi.fn(),
			optIn: vi.fn(),
			optOut: vi.fn(),
			shutdown: vi.fn().mockResolvedValue(undefined),
		}
		;(PostHog as any).mockImplementation(() => mockPostHogClient)

		info = vi.spyOn(console, "info").mockImplementation(() => {})

		setHost({
			...createInMemoryHost(),
			env: {
				language: "en",
				appRoot: "",
				machineId: "test-machine-id",
				appInfo: { name: "shofer", version: "0.0.0", outputChannel: "Shofer" },
			},
			config: { get: vi.fn().mockReturnValue("all") } as any,
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	/** A debug client that has been opted in by the user. */
	const optedInDebugClient = () => {
		const client = new PostHogTelemetryClient(true)
		client.updateTelemetryState(true)
		return client
	}

	describe("capture", () => {
		it("logs the skipped event when the user has not opted in", async () => {
			const client = new PostHogTelemetryClient(true)
			await client.capture({ event: TelemetryEventName.TASK_CREATED, properties: {} })

			expect(mockPostHogClient.capture).not.toHaveBeenCalled()
			expect(info).toHaveBeenCalledWith(
				`[PostHogTelemetryClient#capture] Skipping event: ${TelemetryEventName.TASK_CREATED}`,
			)
		})

		it("logs the skipped event when the subscription excludes it", async () => {
			const client = optedInDebugClient()
			await client.capture({ event: TelemetryEventName.LLM_COMPLETION, properties: {} })

			expect(mockPostHogClient.capture).not.toHaveBeenCalled()
			expect(info).toHaveBeenCalledWith(
				`[PostHogTelemetryClient#capture] Skipping event: ${TelemetryEventName.LLM_COMPLETION}`,
			)
		})

		it("logs the captured event on the way through", async () => {
			const client = optedInDebugClient()
			await client.capture({ event: TelemetryEventName.TASK_CREATED, properties: { taskId: "t1" } })

			expect(info).toHaveBeenCalledWith(`[PostHogTelemetryClient#capture] ${TelemetryEventName.TASK_CREATED}`)
			expect(mockPostHogClient.capture).toHaveBeenCalledWith({
				distinctId: "test-machine-id",
				event: TelemetryEventName.TASK_CREATED,
				properties: { taskId: "t1" },
			})
		})
	})

	describe("captureException", () => {
		it("logs the skipped exception when the user has not opted in", async () => {
			const client = new PostHogTelemetryClient(true)
			await client.captureException(new Error("boom"))

			expect(mockPostHogClient.captureException).not.toHaveBeenCalled()
			expect(info).toHaveBeenCalledWith("[PostHogTelemetryClient#captureException] Skipping exception: boom")
		})

		it("logs an expected API error being filtered out rather than reported", async () => {
			const client = optedInDebugClient()
			const error = Object.assign(new Error("rate limited"), { status: 429 })

			await client.captureException(error)

			expect(mockPostHogClient.captureException).not.toHaveBeenCalled()
			expect(info).toHaveBeenCalledWith(
				expect.stringContaining("[PostHogTelemetryClient#captureException] Filtering out expected error:"),
			)
		})

		it("logs the reported exception on the way through", async () => {
			const client = optedInDebugClient()
			await client.captureException(new Error("boom"))

			expect(info).toHaveBeenCalledWith("[PostHogTelemetryClient#captureException] boom")
			expect(mockPostHogClient.captureException).toHaveBeenCalled()
		})

		it("auto-extracts a ConsecutiveMistakeError's properties, with explicit ones winning", async () => {
			const client = optedInDebugClient()
			const error = new ConsecutiveMistakeError("stuck", "task-1", 3, 3, "tool_repetition", "anthropic", "m1")

			await client.captureException(error, { modelId: "override" })

			const [, distinctId, properties] = mockPostHogClient.captureException.mock.calls[0]
			expect(distinctId).toBe("test-machine-id")
			expect(properties).toMatchObject({
				taskId: "task-1",
				consecutiveMistakeCount: 3,
				consecutiveMistakeLimit: 3,
				reason: "tool_repetition",
				provider: "anthropic",
				modelId: "override",
			})
		})

		it("still reports the exception when the properties provider throws", async () => {
			const client = optedInDebugClient()
			const provider: TelemetryPropertiesProvider = {
				getTelemetryProperties: vi.fn().mockRejectedValue(new Error("provider down")),
			}
			client.setProvider(provider)

			await client.captureException(new Error("boom"))

			expect(mockPostHogClient.captureException).toHaveBeenCalled()
			const [, , properties] = mockPostHogClient.captureException.mock.calls[0]
			expect(properties.$app_version).toBeUndefined()
		})
	})
})
