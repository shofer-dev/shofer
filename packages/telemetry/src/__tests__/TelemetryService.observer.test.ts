import { describe, it, expect, vi } from "vitest"

import { TelemetryEventName } from "@shofer/types"

import { TelemetryService } from "../TelemetryService"

describe("TelemetryService event observers (§10)", () => {
	it("notifies observers on captureEvent, regardless of the telemetry opt-in", () => {
		const service = new TelemetryService([]) // no clients → not "ready", but observers still fire
		const observer = vi.fn()
		service.onEvent(observer)

		service.captureTaskCreated("task-1")

		expect(observer).toHaveBeenCalledWith(TelemetryEventName.TASK_CREATED, { taskId: "task-1" })
	})

	it("stops notifying after unsubscribe, and isolates a throwing observer", () => {
		const service = new TelemetryService([])
		const good = vi.fn()
		const unsub = service.onEvent(() => {
			throw new Error("boom")
		})
		service.onEvent(good)

		service.captureEvent(TelemetryEventName.TASK_COMPLETED, { taskId: "t" })
		expect(good).toHaveBeenCalledTimes(1)

		unsub()
		good.mockClear()
		service.captureEvent(TelemetryEventName.TASK_COMPLETED, { taskId: "t" })
		expect(good).toHaveBeenCalledTimes(1) // the throwing observer was removed; good still fires
	})
})
