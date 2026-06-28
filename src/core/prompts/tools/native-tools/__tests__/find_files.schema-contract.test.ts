import { describe, it, expect } from "vitest"
import type OpenAI from "openai"

import findFiles from "../find_files"

/**
 * §3 schema-as-contract migration safety net for `find_files`.
 *
 * `find_files` was migrated from a hand-written JSON Schema to a single Zod
 * schema (`defineNativeTool`). This test proves the model sees the SAME thing it
 * saw before: the migrated schema, after the provider's OpenAI-strict
 * normalization, deep-equals the normalized form of the pre-migration schema.
 *
 * Normalization mirrors `BaseProvider.convertToolSchemaForOpenAI`: all
 * properties become required, null is stripped from type unions, and
 * `additionalProperties: false` is enforced (recursively). `required` is sorted
 * for order-independent comparison.
 */

type JsonSchema = Record<string, any>

function normalize(schema: JsonSchema | undefined): JsonSchema | undefined {
	if (!schema || typeof schema !== "object" || schema.type !== "object") return schema
	const result: JsonSchema = { ...schema, additionalProperties: false }
	if (result.properties) {
		const keys = Object.keys(result.properties)
		result.required = [...keys].sort()
		const props: JsonSchema = {}
		for (const key of keys) {
			const prop: JsonSchema = { ...result.properties[key] }
			if (Array.isArray(prop.type) && prop.type.includes("null")) {
				const nonNull = prop.type.filter((t: string) => t !== "null")
				prop.type = nonNull.length === 1 ? nonNull[0] : nonNull
			}
			if (prop.type === "object") props[key] = normalize(prop)
			else if (prop.type === "array" && prop.items?.type === "object")
				props[key] = { ...prop, items: normalize(prop.items) }
			else props[key] = prop
		}
		result.properties = props
	}
	return result
}

/** The exact schema `find_files` emitted before the §3 migration. */
const PRE_MIGRATION_PARAMETERS: JsonSchema = {
	type: "object",
	properties: {
		pattern: {
			type: "string",
			description: "Glob pattern to match files (e.g., '*.ts', '**/*.json')",
		},
		maxResults: {
			type: ["number", "null"],
			description: "Maximum number of results to return (default: 100)",
		},
	},
	required: ["pattern", "maxResults"],
	additionalProperties: false,
}

describe("find_files schema-as-contract migration", () => {
	const fn = (findFiles as OpenAI.Chat.ChatCompletionFunctionTool).function

	it("keeps the same tool name and strict flag", () => {
		expect(fn.name).toBe("find_files")
		expect(fn.strict).toBe(true)
	})

	it("normalizes to the same schema the model saw before migration", () => {
		const before = normalize(PRE_MIGRATION_PARAMETERS)
		const after = normalize(fn.parameters as JsonSchema)
		expect(after).toEqual(before)
	})

	it("exposes the Zod schema for arg-type inference", () => {
		expect((findFiles as any).schema).toBeDefined()
		// The Zod schema validates a representative call.
		const parsed = (findFiles as any).schema.parse({ pattern: "**/*.ts" })
		expect(parsed.pattern).toBe("**/*.ts")
	})
})
