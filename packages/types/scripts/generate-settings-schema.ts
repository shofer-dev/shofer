/**
 * Generates the JSON Schema for `.shofer/settings.json` scope files from
 * `globalSettingsSchema` (packages/types/src/global-settings.ts).
 *
 * The output is written to `schemas/shofer-settings.json` at the repository
 * root, and is the machine-readable contract non-TypeScript writers of a scope
 * file validate against. Run via:
 *   pnpm --filter @shofer/types generate:schema
 *
 * `settings-json-schema-sync.spec.ts` fails if the checked-in file and the Zod
 * schema disagree, so regeneration is enforced rather than remembered.
 */

import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

import { generateSettingsJsonSchema } from "../src/settings-json-schema.js"

const jsonSchema = generateSettingsJsonSchema()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "../../..")
const outPath = path.join(repoRoot, "schemas", "shofer-settings.json")
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(jsonSchema, null, "\t") + "\n", "utf-8")

console.log(`Generated ${path.relative(repoRoot, outPath)}`)
