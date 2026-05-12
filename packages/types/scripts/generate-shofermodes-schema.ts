/**
 * Generates the JSON Schema for .shofermodes configuration files from the Zod
 * schemas defined in packages/types/src/mode.ts.
 *
 * This ensures the schema stays in sync with the TypeScript types. Run via:
 *   pnpm --filter @shofer/types generate:schema
 *
 * The output is written to schemas/shofermodes.json at the repository root.
 */

import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

import { generateRoomodesJsonSchema } from "../src/shofermodes-schema.js"

const jsonSchema = generateRoomodesJsonSchema()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "../../..")
const outPath = path.join(repoRoot, "schemas", "roomodes.json")
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(jsonSchema, null, "\t") + "\n", "utf-8")

console.log(`Generated ${path.relative(repoRoot, outPath)}`)
