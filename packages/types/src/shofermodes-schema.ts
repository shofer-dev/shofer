/**
 * Builds the Zod schema for .shofermodes configuration files and converts it
 * to JSON Schema (draft-07). This module is the single source of truth for
 * both the generator script (scripts/generate-shofermodes-schema.ts) and the
 * drift-detection test.
 */

import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"

import { toolGroupNameSchema } from "./tool.js"
import { groupOptionsSchema, modeConfigObjectSchema } from "./mode.js"

// Build a GroupEntry schema over the OPEN category vocabulary: a mode may list a
// dynamic category, so the constraint an editor enforces is the slug grammar,
// not membership in the builtin enum.
const groupEntrySchema = z.union([toolGroupNameSchema, z.tuple([toolGroupNameSchema, groupOptionsSchema])])

// Build the RuleFile schema (used during import/export but not part of the
// core Zod types).
const ruleFileSchema = z.object({
	relativePath: z.string(),
	content: z.string().optional(),
})

// Build an extended ModeConfig schema that includes rulesFiles and uses the
// extended tools (with deprecated entries).
const exportedModeConfigSchema = modeConfigObjectSchema.omit({ tools: true }).extend({
	tools: z.array(groupEntrySchema),
	rulesFiles: z.array(ruleFileSchema).optional(),
})

// Build the top-level .shofermodes schema.
const shofermodesZodSchema = z
	.object({
		customModes: z.array(exportedModeConfigSchema),
	})
	.strict()

/**
 * Generates the JSON Schema object for .shofermodes configuration files.
 * Includes metadata fields ($id, title, description).
 */
export function generateShofermodesJsonSchema(): Record<string, unknown> {
	const jsonSchema = zodToJsonSchema(shofermodesZodSchema, {
		$refStrategy: "none",
		target: "jsonSchema7",
	}) as Record<string, unknown>

	jsonSchema["$id"] = "https://github.com/shofer-dev/shofer/blob/main/schemas/shofermodes.json"
	jsonSchema["title"] = "Shofer Custom Modes"
	jsonSchema["description"] = "Schema for .shofermodes configuration files used by Shofer to define custom modes."

	return jsonSchema
}
