// Must be FIRST — hoisted above the imports so the module-level
// `const TELEMETRY_ENABLED = process.env.TELEMETRY_ENABLED === "true"` in
// TelemetryService.ts evaluates to FALSE for this file's module registry,
// whatever a sibling test file set.
vi.hoisted(() => {
	process.env.TELEMETRY_ENABLED = "false"
})

// pnpm --filter @shofer/telemetry test src/__tests__/TelemetryService.disabled.test.ts

import { type TelemetryClient, type TelemetryEvent, type TelemetryPropertiesProvider } from "@shofer/types"

import { TelemetryService } from "../TelemetryService.js"

/**
 * The build-flag half of the opt-in gate. Telemetry is opt-in behind BOTH the
 * `TELEMETRY_ENABLED` build flag and the user's `TelemetrySetting`; with the flag
 * off nothing may reach a transport — not even a client someone registers by hand
 * — while the observer fan-out (which is not telemetry) must keep working.
 */

class RecordingClient implements TelemetryClient {
	public readonly events: TelemetryEvent[] = []
	public readonly exceptions: Error[] = []
	public provider: TelemetryPropertiesProvider | undefined
	public optedIn = false
	public didShutdown = false

	public setProvider(provider: TelemetryPropertiesProvider): void {
		this.provider = provider
	}
	public async capture(event: TelemetryEvent): Promise<void> {
		this.events.push(event)
	}
	public async captureException(error: Error): Promise<void> {
		this.exceptions.push(error)
	}
	public updateTelemetryState(isOptedIn: boolean): void {
		this.optedIn = isOptedIn
	}
	public isTelemetryEnabled(): boolean {
		return true // even a client claiming to be on must not make the service on
	}
	public async shutdown(): Promise<void> {
		this.didShutdown = true
	}
}

describe("TelemetryService (TELEMETRY_ENABLED unset)", () => {
	let client: RecordingClient

	beforeEach(() => {
		client = new RecordingClient()
	})

	it("reports the build flag as off", () => {
		expect(TelemetryService.isGloballyEnabled()).toBe(false)
	})

	it("refuses to register a client at all", () => {
		const service = new TelemetryService([])
		service.register(client)

		service.captureTaskCreated("t1")
		expect(client.events).toEqual([])
	})

	it("captures nothing even through a client passed to the constructor", () => {
		const service = new TelemetryService([client])

		service.captureTaskCreated("t1")
		service.captureToolUsage("t1", "read_file")
		service.captureException(new Error("boom"))

		expect(client.events).toEqual([])
		expect(client.exceptions).toEqual([])
	})

	it("still fans events out to observers — plugins see agent events with telemetry off", () => {
		const service = new TelemetryService([client])
		const observer = vi.fn()
		service.onEvent(observer)

		service.captureTaskCompleted("t1")

		expect(observer).toHaveBeenCalledTimes(1)
		expect(client.events).toEqual([])
	})

	it("does not forward the properties provider", () => {
		const service = new TelemetryService([client])
		service.setProvider({ getTelemetryProperties: vi.fn() })
		expect(client.provider).toBeUndefined()
	})

	it("does not propagate the user's TelemetrySetting to a client", () => {
		const service = new TelemetryService([client])
		service.updateTelemetryState(true)
		expect(client.optedIn).toBe(false)
	})

	it("is never telemetry-enabled, however the client answers", () => {
		expect(new TelemetryService([client]).isTelemetryEnabled()).toBe(false)
	})

	it("does not shut a client down it never used", async () => {
		await new TelemetryService([client]).shutdown()
		expect(client.didShutdown).toBe(false)
	})

	it("createInstance DROPS the clients it is handed", () => {
		expect(TelemetryService.hasInstance()).toBe(false)
		const service = TelemetryService.createInstance([client])
		expect(TelemetryService.instance).toBe(service)

		service.captureTaskCreated("t1")
		expect(client.events).toEqual([])
	})
})
