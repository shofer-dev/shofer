import { describe, it, expect } from "vitest"

import { globalSettingsSchema } from "../global-settings.js"

describe("globalSettingsSchema — maxParallelTasks", () => {
	// The settings UI persists `null` to represent the "unset" state (so the
	// backend falls back to the default of 10). The schema must therefore accept
	// null as well as undefined — otherwise getGlobalSettings()'s
	// globalSettingsSchema.parse() throws a ZodError whenever the field is cleared.
	it("accepts null (cleared field)", () => {
		const result = globalSettingsSchema.safeParse({ maxParallelTasks: null })
		expect(result.success).toBe(true)
	})

	it("accepts undefined (omitted)", () => {
		const result = globalSettingsSchema.safeParse({})
		expect(result.success).toBe(true)
	})

	it("accepts 0 (unlimited) and positive integers", () => {
		expect(globalSettingsSchema.safeParse({ maxParallelTasks: 0 }).success).toBe(true)
		expect(globalSettingsSchema.safeParse({ maxParallelTasks: 10 }).success).toBe(true)
	})

	it("rejects negative and non-integer values", () => {
		expect(globalSettingsSchema.safeParse({ maxParallelTasks: -1 }).success).toBe(false)
		expect(globalSettingsSchema.safeParse({ maxParallelTasks: 2.5 }).success).toBe(false)
	})
})
