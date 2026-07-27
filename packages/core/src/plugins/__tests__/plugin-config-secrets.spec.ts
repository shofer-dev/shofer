import { describe, it, expect } from "vitest"

import { pluginConfigSecretKeys } from "@shofer/types"

import {
	applyPluginSecretEdits,
	redactPluginSecretConfig,
	splitPluginConfigBySecrets,
} from "../plugin-config-secrets.js"

/**
 * The credential/preference boundary a plugin's config is split along.
 *
 * These rules are what let a settings panel that is NEVER shown a stored secret still
 * save the form it is part of: an absent property means "leave the key alone", and only
 * an explicit empty string deletes one. Get that wrong and either every save wipes the
 * user's credentials, or a cleared field silently keeps working.
 */
describe("plugin config secrets", () => {
	const SECRETS = pluginConfigSecretKeys({
		type: "object",
		properties: {
			qdrantUrl: { type: "string" },
			qdrantApiKey: { type: "string", secret: true },
			embedderApiKey: { type: "string", secret: true },
		},
	})

	it("reads the secret property names off the schema", () => {
		expect(SECRETS).toEqual(["qdrantApiKey", "embedderApiKey"])
		expect(pluginConfigSecretKeys(undefined)).toEqual([])
	})

	it("routes each property to the store it belongs in", () => {
		expect(
			splitPluginConfigBySecrets({ qdrantUrl: "http://q:6333", qdrantApiKey: "k-1", retries: 3 }, SECRETS),
		).toEqual({
			plain: { qdrantUrl: "http://q:6333", retries: 3 },
			secrets: { qdrantApiKey: "k-1" },
		})
	})

	it("refuses a non-string for a secret property rather than storing it", () => {
		expect(splitPluginConfigBySecrets({ qdrantApiKey: { nested: true } }, SECRETS).secrets).toEqual({})
	})

	it("leaves a stored key untouched when the edit omits it", () => {
		expect(applyPluginSecretEdits({ qdrantApiKey: "kept", embedderApiKey: "also-kept" }, {})).toEqual({
			qdrantApiKey: "kept",
			embedderApiKey: "also-kept",
		})
	})

	it("replaces on a new value and deletes on an empty one", () => {
		expect(
			applyPluginSecretEdits(
				{ qdrantApiKey: "old", embedderApiKey: "gone-soon" },
				{ qdrantApiKey: "new", embedderApiKey: "" },
			),
		).toEqual({ qdrantApiKey: "new" })
	})

	it("keeps a credential out of anything the host hands back", () => {
		// Only reachable for a value stored before its property was declared secret —
		// which is exactly the case a panel would leak.
		expect(redactPluginSecretConfig({ qdrantUrl: "http://q:6333", qdrantApiKey: "leaked" }, SECRETS)).toEqual({
			qdrantUrl: "http://q:6333",
		})
		expect(redactPluginSecretConfig({ a: 1 }, [])).toEqual({ a: 1 })
	})
})
