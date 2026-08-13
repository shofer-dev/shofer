/**
 * Builds the JSON Schema (draft-07) for a `.shofer/settings.json` scope file
 * from `globalSettingsSchema`, and is the single source of truth for both the
 * generator script (`scripts/generate-settings-schema.ts`, which writes
 * `schemas/shofer-settings.json`) and the drift-detection test.
 *
 * Why this artifact exists at all: the schema is enforced INSIDE the pod, by
 * `readScopeSettingsFile` in `@shofer/core`, but the file is usually AUTHORED
 * somewhere else — a provisioning platform, an org console, a checked-in
 * project scope. Those writers are not TypeScript, cannot import Zod, and were
 * therefore reduced to transcribing individual constraints by hand; every
 * transcription is a copy that drifts the moment a key is added or a bound
 * moves. Exporting the schema in a language-neutral form lets a writer validate
 * the WHOLE document against the same constraints the reader applies, and lets
 * a new key be covered on the day it lands here rather than on the day someone
 * downstream notices.
 *
 * Two properties of the emitted schema are load-bearing and deliberate:
 *
 * 1. It is generated from `globalSettingsSchema.partial()` — the exact schema
 *    `readScopeSettingsFile` parses a scope file with. Every key optional; a
 *    key that is PRESENT still has to satisfy its own constraints.
 * 2. `removeAdditionalStrategy: "strict"` makes a strip-mode `z.object` emit
 *    `additionalProperties: true`, which is what Zod's strip semantics actually
 *    are: an unknown key is DISCARDED, not an error. The library's default
 *    (`additionalProperties: false`) would make a validator downstream reject
 *    documents the reader happily accepts — a false alarm on every key added by
 *    a newer Shofer than the artifact.
 *
 * What it does NOT capture, and cannot: constraints Zod expresses in code
 * rather than in structure — `.refine`/`.superRefine`/`.transform`, and any
 * `z.custom`. Those degrade to a permissive sub-schema, so the artifact is
 * sound (never rejects what the reader accepts) but not complete (may accept
 * what the reader rejects). `globalSettingsSchema` carries no object-level
 * refinement today; a future one would be invisible here, which is exactly why
 * the reader keeps its own guard (see `readScopeSettingsFile`).
 */

import { zodToJsonSchema } from "zod-to-json-schema"

import { globalSettingsSchema } from "./global-settings.js"

/** The `$id` under which the generated artifact is published. */
export const SETTINGS_JSON_SCHEMA_ID = "https://github.com/shofer-dev/shofer/blob/main/schemas/shofer-settings.json"

/**
 * Generate the JSON Schema object describing one `.shofer/settings.json` scope
 * file. Includes metadata fields (`$id`, `title`, `description`).
 */
export function generateSettingsJsonSchema(): Record<string, unknown> {
	const jsonSchema = zodToJsonSchema(globalSettingsSchema.partial(), {
		$refStrategy: "none",
		target: "jsonSchema7",
		// Zod's `strip` discards unknown keys; say so, rather than the library's
		// default of forbidding them.
		removeAdditionalStrategy: "strict",
	}) as Record<string, unknown>

	jsonSchema["$id"] = SETTINGS_JSON_SCHEMA_ID
	jsonSchema["title"] = "Shofer Layered Settings (.shofer/settings.json)"
	jsonSchema["description"] =
		"Schema for a single `.shofer/settings.json` scope file, generated from `globalSettingsSchema.partial()` — " +
		"the schema Shofer itself parses each scope file with. Every key is optional; a key that is present must " +
		"satisfy its constraints, and unknown keys are ignored rather than rejected."

	return jsonSchema
}
