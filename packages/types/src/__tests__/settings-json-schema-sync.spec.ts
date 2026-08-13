import { describe, it, expect } from "vitest"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

import { generateSettingsJsonSchema } from "../settings-json-schema.js"

/**
 * Verifies that the checked-in `schemas/shofer-settings.json` matches what the
 * current Zod schemas generate. If this fails, run:
 *
 *   pnpm --filter @shofer/types generate:schema
 *
 * This test is the whole reason a downstream writer can trust the artifact: a
 * key added to `globalSettingsSchema` without regenerating it fails HERE, in
 * the repo that owns the schema, rather than silently shipping an artifact that
 * describes a Shofer that no longer exists.
 */
describe("shofer-settings schema sync", () => {
	it("matches the schema generated from the Zod types", () => {
		const __dirname = path.dirname(fileURLToPath(import.meta.url))
		const schemaPath = path.resolve(__dirname, "../../../../schemas/shofer-settings.json")
		const checkedIn = JSON.parse(fs.readFileSync(schemaPath, "utf-8"))

		expect(checkedIn).toEqual(generateSettingsJsonSchema())
	})
})
