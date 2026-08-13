/**
 * Validates the generated `schemas/shofer-settings.json` with AJV, and asserts
 * the property the artifact exists for: **a document the artifact accepts is a
 * document `globalSettingsSchema.partial()` accepts, and vice versa.** Every
 * case below is checked against BOTH, so a divergence between the exported
 * schema and the Zod source of truth fails here rather than downstream.
 *
 * `settings-json-schema-sync.spec.ts` separately guards the checked-in file
 * against the generator.
 */
import { describe, it, expect, beforeAll } from "vitest"
import Ajv, { type ValidateFunction } from "ajv"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

import { globalSettingsSchema } from "../global-settings.js"

describe("shofer-settings JSON schema", () => {
	let validate: ValidateFunction

	beforeAll(() => {
		const __dirname = path.dirname(fileURLToPath(import.meta.url))
		const schemaPath = path.resolve(__dirname, "../../../../schemas/shofer-settings.json")
		const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"))
		const ajv = new Ajv.default({ strict: false })
		validate = ajv.compile(schema)
	})

	/** Assert the artifact and the Zod schema reach the same verdict. */
	const expectAgreement = (doc: unknown, accepted: boolean) => {
		expect(validate(doc), `JSON Schema verdict for ${JSON.stringify(doc)}`).toBe(accepted)
		expect(globalSettingsSchema.partial().safeParse(doc).success, `Zod verdict for ${JSON.stringify(doc)}`).toBe(
			accepted,
		)
	}

	it("accepts an empty document", () => {
		expectAgreement({}, true)
	})

	it("ignores unknown keys rather than rejecting them", () => {
		// Zod strips; the artifact must say `additionalProperties: true`, or a
		// writer validating against it would reject every key added by a newer
		// Shofer than the artifact it holds.
		expectAgreement({ someKeyFromANewerShofer: 42 }, true)
	})

	// The two defects that were each caught by a hand-written validator.
	it("rejects defaultCostLimit.maxUsd = 0 (z.number().positive())", () => {
		expectAgreement({ defaultCostLimit: { maxUsd: 0, action: "pause" } }, false)
	})

	it("accepts defaultCostLimit = null, the documented way to disable the cap", () => {
		expectAgreement({ defaultCostLimit: null }, true)
	})

	it("accepts a positive defaultCostLimit", () => {
		expectAgreement({ defaultCostLimit: { maxUsd: 5, action: "abort" } }, true)
	})

	it("rejects an unknown defaultCostLimit.action", () => {
		expectAgreement({ defaultCostLimit: { maxUsd: 5, action: "explode" } }, false)
	})

	it("rejects maxConsecutiveApiFailures = 0 (z.number().int().min(1))", () => {
		expectAgreement({ maxConsecutiveApiFailures: 0 }, false)
	})

	it("rejects a fractional maxConsecutiveApiFailures", () => {
		expectAgreement({ maxConsecutiveApiFailures: 1.5 }, false)
	})

	it("accepts maxConsecutiveApiFailures = 1", () => {
		expectAgreement({ maxConsecutiveApiFailures: 1 }, true)
	})

	// Keys no hand-written validator ever knew about — the point of exporting
	// the whole schema instead of transcribing keys one at a time.
	it("rejects a negative writeDelayMs (z.number().min(0))", () => {
		expectAgreement({ writeDelayMs: -1 }, false)
	})

	it("rejects an out-of-vocabulary settingsWriteScope", () => {
		expectAgreement({ settingsWriteScope: "org" }, false)
	})

	it("rejects a wrong-typed autoApprovalEnabled", () => {
		expectAgreement({ autoApprovalEnabled: "yes" }, false)
	})
})
