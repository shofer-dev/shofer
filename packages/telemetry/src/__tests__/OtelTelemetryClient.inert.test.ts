// pnpm --filter @shofer/telemetry test src/__tests__/OtelTelemetryClient.inert.test.ts

import { trace } from "@opentelemetry/api"

import { TelemetryEventName } from "@shofer/types"

import { OtelTelemetryClient } from "../OtelTelemetryClient.js"

/**
 * The inert half of the OTel transport: with the user opted out nothing becomes
 * a span (exceptions included), an excluded event is dropped even when opted in,
 * and `shutdown()` is a no-op because the SDK the HOST registers owns exporter
 * flush.
 */
describe("OtelTelemetryClient when it must stay inert", () => {
	const startSpan = vi.fn(() => ({
		setAttribute: vi.fn(),
		recordException: vi.fn(),
		setStatus: vi.fn(),
		end: vi.fn(),
	}))

	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(trace, "getTracer").mockReturnValue({ startSpan } as never)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("records no exception span while the user has not opted in", async () => {
		const client = new OtelTelemetryClient()
		await client.captureException(new Error("boom"), { where: "test" })
		expect(startSpan).not.toHaveBeenCalled()
	})

	it("stops emitting again once the user opts back out", async () => {
		const client = new OtelTelemetryClient()
		client.updateTelemetryState(true)
		client.updateTelemetryState(false)

		await client.capture({ event: TelemetryEventName.TASK_CREATED, properties: { taskId: "t1" } })
		expect(startSpan).not.toHaveBeenCalled()
	})

	it("drops null and undefined attributes rather than sending them", async () => {
		const client = new OtelTelemetryClient()
		client.updateTelemetryState(true)

		await client.capture({
			event: TelemetryEventName.TASK_CREATED,
			properties: { taskId: "t1", nothing: null, missing: undefined, count: 2, flag: false },
		})

		const [, opts] = startSpan.mock.calls[0] as unknown as [string, { attributes: Record<string, unknown> }]
		expect(opts.attributes).toEqual({ taskId: "t1", count: 2, flag: false })
	})

	it("emits an exception span with no attributes when none are supplied", async () => {
		const client = new OtelTelemetryClient()
		client.updateTelemetryState(true)

		await client.captureException(new Error("boom"))

		const [name, opts] = startSpan.mock.calls[0] as unknown as [string, { attributes: Record<string, unknown> }]
		expect(name).toBe("shofer.exception")
		expect(opts.attributes).toEqual({})
	})

	it("shutdown resolves without touching the tracer — the host's SDK owns flush", async () => {
		const client = new OtelTelemetryClient()
		client.updateTelemetryState(true)
		await expect(client.shutdown()).resolves.toBeUndefined()
		expect(startSpan).not.toHaveBeenCalled()
	})
})
