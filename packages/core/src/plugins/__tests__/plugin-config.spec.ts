import { describe, it, expect } from "vitest"

import { resolvePluginConfig } from "../plugin-manager.js"

describe("resolvePluginConfig (step 2.3)", () => {
	const manifestConfig = {
		type: "object",
		properties: {
			jenkinsUrl: { type: "string", description: "Jenkins base URL" },
			defaultEnvironment: { type: "string", enum: ["staging", "production"], default: "staging" },
			retries: { type: "number", default: 3 },
		},
	}

	it("fills manifest-declared defaults for unset keys", () => {
		expect(resolvePluginConfig(manifestConfig, undefined)).toEqual({
			defaultEnvironment: "staging",
			retries: 3,
		})
	})

	it("lets stored values win over defaults", () => {
		expect(resolvePluginConfig(manifestConfig, { defaultEnvironment: "production", jenkinsUrl: "x" })).toEqual({
			defaultEnvironment: "production",
			jenkinsUrl: "x",
			retries: 3,
		})
	})

	it("returns stored values unchanged when the manifest declares no config", () => {
		expect(resolvePluginConfig(undefined, { a: 1 })).toEqual({ a: 1 })
	})

	it("returns an empty object when nothing is declared or stored", () => {
		expect(resolvePluginConfig(undefined, undefined)).toEqual({})
	})

	it("does not overwrite a stored key even when its value is falsy", () => {
		expect(resolvePluginConfig(manifestConfig, { retries: 0 })).toEqual({
			retries: 0,
			defaultEnvironment: "staging",
		})
	})
})
