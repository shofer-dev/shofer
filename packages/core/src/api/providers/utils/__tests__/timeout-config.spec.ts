// npx vitest run api/providers/utils/__tests__/timeout-config.spec.ts

import { createInMemoryHost, setHost } from "@shofer/types"

import { getApiRequestTimeout } from "../timeout-config.js"

/**
 * Install an in-memory host whose `config.get` returns `value` for the
 * `apiRequestTimeout` setting, mirroring how the extension host would surface
 * the VS Code configuration.
 */
function installHostWithTimeout(value: unknown): void {
	const base = createInMemoryHost()
	setHost({
		...base,
		config: {
			...base.config,
			get: <T>(_pkg: string, key: string, defaultValue?: T): T =>
				key === "apiRequestTimeout" ? (value as T) : (defaultValue as T),
		},
	})
}

describe("getApiRequestTimeout", () => {
	it("should return default timeout of 600000ms when no configuration is set", () => {
		installHostWithTimeout(600)
		expect(getApiRequestTimeout()).toBe(600000) // 600 seconds in milliseconds
	})

	it("should return custom timeout in milliseconds", () => {
		installHostWithTimeout(1200) // 20 minutes
		expect(getApiRequestTimeout()).toBe(1200000) // 1200 seconds in milliseconds
	})

	it("should return undefined for zero timeout (disables timeout)", () => {
		installHostWithTimeout(0)
		// Zero means "no timeout" - return undefined so SDK uses its default
		// (OpenAI SDK interprets 0 as "abort immediately", so we avoid that)
		expect(getApiRequestTimeout()).toBeUndefined()
	})

	it("should return undefined for negative values (disables timeout)", () => {
		installHostWithTimeout(-100)
		// Negative values also mean "no timeout" - return undefined
		expect(getApiRequestTimeout()).toBeUndefined()
	})

	it("should handle null by using default", () => {
		installHostWithTimeout(null)
		expect(getApiRequestTimeout()).toBe(600000) // Should fall back to default 600 seconds
	})

	it("should handle undefined by using default", () => {
		installHostWithTimeout(undefined)
		expect(getApiRequestTimeout()).toBe(600000) // Should fall back to default 600 seconds
	})

	it("should handle NaN by using default", () => {
		installHostWithTimeout(NaN)
		expect(getApiRequestTimeout()).toBe(600000) // Should fall back to default 600 seconds
	})

	it("should handle string values by using default", () => {
		installHostWithTimeout("not-a-number") // String instead of number
		expect(getApiRequestTimeout()).toBe(600000) // Should fall back to default since it's not a number
	})

	it("should handle boolean values by using default", () => {
		installHostWithTimeout(true) // Boolean instead of number
		expect(getApiRequestTimeout()).toBe(600000) // Should fall back to default since it's not a number
	})
})
