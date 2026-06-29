import { describe, it, expect, vi, beforeEach } from "vitest"
import { trace } from "@opentelemetry/api"

import { TelemetryEventName } from "@shofer/types"

import { OtelTelemetryClient } from "../OtelTelemetryClient"

/**
 * §8 OTel transport. Verifies events become spans (with flattened attributes)
 * once telemetry is opted in, and that the client is inert otherwise. Uses a
 * stub span/tracer (no SDK registered → @opentelemetry/api is a no-op in prod).
 */
describe("OtelTelemetryClient", () => {
	const setSpan = vi.fn()
	const endSpan = vi.fn()
	const recordException = vi.fn()
	const setStatus = vi.fn()
	const startSpan = vi.fn(() => ({ setAttribute: setSpan, recordException, setStatus, end: endSpan }))

	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(trace, "getTracer").mockReturnValue({ startSpan } as never)
	})

	const event = { event: TelemetryEventName.TASK_CREATED, properties: { taskId: "t1", nested: { a: 1 } } } as never

	it("does nothing until telemetry is opted in", async () => {
		const client = new OtelTelemetryClient()
		await client.capture(event)
		expect(startSpan).not.toHaveBeenCalled()
	})

	it("emits a span per event with flattened attributes once opted in", async () => {
		const client = new OtelTelemetryClient()
		client.updateTelemetryState(true)
		await client.capture(event)
		expect(startSpan).toHaveBeenCalledTimes(1)
		const [name, opts] = startSpan.mock.calls[0] as unknown as [string, { attributes: Record<string, unknown> }]
		expect(name).toBe(`shofer.${TelemetryEventName.TASK_CREATED}`)
		expect(opts.attributes.taskId).toBe("t1")
		expect(opts.attributes.nested).toBe(JSON.stringify({ a: 1 })) // objects are stringified
		expect(endSpan).toHaveBeenCalled()
	})

	it("records exceptions as error spans", async () => {
		const client = new OtelTelemetryClient()
		client.updateTelemetryState(true)
		await client.captureException(new Error("boom"), { where: "test" })
		expect(recordException).toHaveBeenCalled()
		expect(setStatus).toHaveBeenCalled()
		expect(endSpan).toHaveBeenCalled()
	})
})
