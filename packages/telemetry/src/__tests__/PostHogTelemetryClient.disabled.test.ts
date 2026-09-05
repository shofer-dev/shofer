// Must be FIRST — hoisted above the imports so the module-level
// `const TELEMETRY_ENABLED = process.env.TELEMETRY_ENABLED === "true"` in
// PostHogTelemetryClient.ts evaluates to FALSE for this file's module registry,
// whatever a sibling test file set.
vi.hoisted(() => {
	process.env.TELEMETRY_ENABLED = "false"
})

/* eslint-disable @typescript-eslint/no-explicit-any */

// pnpm --filter @shofer/telemetry test src/__tests__/PostHogTelemetryClient.disabled.test.ts

import { PostHog } from "posthog-node"

import { TelemetryEventName, setHost, createInMemoryHost } from "@shofer/types"

import { PostHogTelemetryClient } from "../PostHogTelemetryClient.js"

vi.mock("posthog-node")

/**
 * With the build flag off the PostHog client is never constructed at all — no
 * API key is read, no machineId is taken as a distinct id, and the user's
 * `TelemetrySetting` cannot switch any of it back on. This is the half of the
 * opt-in gate the main suite (which forces the flag on) cannot exercise.
 */
describe("PostHogTelemetryClient (TELEMETRY_ENABLED unset)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
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

	it("never constructs a PostHog client, and takes no machine id", () => {
		const client = new PostHogTelemetryClient()

		expect(PostHog).not.toHaveBeenCalled()
		expect((client as any).client).toBeNull()
		expect((client as any).distinctId).toBe("")
	})

	it("stays disabled however the user opts in, without consulting the host config", () => {
		const configGet = vi.fn().mockReturnValue("all")
		setHost({
			...createInMemoryHost(),
			env: {
				language: "en",
				appRoot: "",
				machineId: "test-machine-id",
				appInfo: { name: "shofer", version: "0.0.0", outputChannel: "Shofer" },
			},
			config: { get: configGet } as any,
		})

		const client = new PostHogTelemetryClient()
		client.updateTelemetryState(true)

		expect(client.isTelemetryEnabled()).toBe(false)
		expect(configGet).not.toHaveBeenCalled()
	})

	it("captures nothing", async () => {
		const client = new PostHogTelemetryClient()
		client.updateTelemetryState(true)

		await client.capture({ event: TelemetryEventName.TASK_CREATED, properties: { taskId: "t1" } })
		await client.captureException(new Error("boom"))
		await client.shutdown()

		// Nothing to flush: there is no underlying client to have been called.
		expect((client as any).client).toBeNull()
	})
})
