// npx vitest run __tests__/delegation-events.spec.ts

import { ShoferEventName, shoferEventsSchema, taskEventSchema } from "@shofer/types"

describe("delegation event schemas", () => {
	test("shoferEventsSchema validates tuples", () => {
		expect(() => (shoferEventsSchema.shape as any)[ShoferEventName.TaskDelegated].parse(["p", "c"])).not.toThrow()
		expect(() =>
			(shoferEventsSchema.shape as any)[ShoferEventName.TaskDelegationCompleted].parse(["p", "c", "s"]),
		).not.toThrow()
		expect(() =>
			(shoferEventsSchema.shape as any)[ShoferEventName.TaskDelegationResumed].parse(["p", "c"]),
		).not.toThrow()

		// invalid shapes
		expect(() => (shoferEventsSchema.shape as any)[ShoferEventName.TaskDelegated].parse(["p"])).toThrow()
		expect(() =>
			(shoferEventsSchema.shape as any)[ShoferEventName.TaskDelegationCompleted].parse(["p", "c"]),
		).toThrow()
		expect(() => (shoferEventsSchema.shape as any)[ShoferEventName.TaskDelegationResumed].parse(["p"])).toThrow()
	})

	test("taskEventSchema discriminated union includes delegation events", () => {
		expect(() =>
			taskEventSchema.parse({
				eventName: ShoferEventName.TaskDelegated,
				payload: ["p", "c"],
				taskId: 1,
			}),
		).not.toThrow()

		expect(() =>
			taskEventSchema.parse({
				eventName: ShoferEventName.TaskDelegationCompleted,
				payload: ["p", "c", "s"],
				taskId: 1,
			}),
		).not.toThrow()

		expect(() =>
			taskEventSchema.parse({
				eventName: ShoferEventName.TaskDelegationResumed,
				payload: ["p", "c"],
				taskId: 1,
			}),
		).not.toThrow()
	})
})
