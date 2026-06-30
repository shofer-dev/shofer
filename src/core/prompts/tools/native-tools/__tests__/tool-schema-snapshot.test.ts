import { describe, it, expect } from "vitest"
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type OpenAI from "openai"

import { getNativeTools } from "../index"

/**
 * Tool-schema golden snapshots (v3 architecture §3).
 *
 * Locks the *normalized* schema (and description) of every native tool. Two jobs:
 *
 *  1. **Contract guard** — the schema/description sent to the model is the tool's
 *     external contract. Any accidental change (a tweaked description, a dropped
 *     param) shows up here as a reviewable diff instead of silently altering model
 *     behavior in production.
 *  2. **Migration safety net (§3)** — schemas are snapshotted in their *normalized*
 *     form (the OpenAI-strict transform the provider applies at send time, mirrored
 *     by `normalize` below). Normalization collapses the optional/nullable-required
 *     distinction, so migrating a tool from a hand-written JSON Schema to a
 *     `defineNativeTool` Zod schema leaves the snapshot unchanged *iff* the model
 *     truly sees the same thing. This lets the remaining native tools migrate to
 *     schema-as-contract without access to a live provider.
 *
 * Regenerate after an intentional schema change:
 *   UPDATE_TOOL_SCHEMAS=1 pnpm --filter shofer test -- tool-schema-snapshot
 */

type JsonSchema = Record<string, any>

/** Mirrors `BaseProvider.convertToolSchemaForOpenAI` (OpenAI strict mode). */
function normalize(schema: JsonSchema | undefined): JsonSchema | undefined {
	if (!schema || typeof schema !== "object" || schema.type !== "object") return schema
	const result: JsonSchema = { ...schema, additionalProperties: false }
	if (result.properties) {
		const keys = Object.keys(result.properties)
		result.required = [...keys].sort()
		const props: JsonSchema = {}
		for (const key of [...keys].sort()) {
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

const SCHEMA_DIR = join(__dirname, "__schemas__")

function snapshotOf(tool: OpenAI.Chat.ChatCompletionFunctionTool) {
	return {
		name: tool.function.name,
		// `strict` is part of the contract: a tool that disables strict mode does so
		// deliberately (e.g. to let the model omit advisory params). Capture it so a
		// migration can't silently flip it.
		strict: tool.function.strict ?? false,
		description: tool.function.description ?? "",
		parameters: normalize(tool.function.parameters as JsonSchema) ?? null,
	}
}

const UPDATE = process.env.UPDATE_TOOL_SCHEMAS === "1"

const fnTools = getNativeTools({ supportsImages: true }).filter(
	(t): t is OpenAI.Chat.ChatCompletionFunctionTool =>
		(t as OpenAI.Chat.ChatCompletionFunctionTool).type === "function",
)

describe("native tool schema snapshots", () => {
	if (UPDATE) {
		it("regenerates golden snapshots", () => {
			mkdirSync(SCHEMA_DIR, { recursive: true })
			for (const tool of fnTools) {
				writeFileSync(
					join(SCHEMA_DIR, `${tool.function.name}.json`),
					JSON.stringify(snapshotOf(tool), null, 2) + "\n",
				)
			}
			expect(fnTools.length).toBeGreaterThan(0)
		})
		return
	}

	it.each(fnTools.map((t) => [t.function.name, t] as const))("%s matches its golden schema", (name, tool) => {
		const file = join(SCHEMA_DIR, `${name}.json`)
		expect(existsSync(file), `missing golden for ${name} — run UPDATE_TOOL_SCHEMAS=1`).toBe(true)
		const golden = JSON.parse(readFileSync(file, "utf8"))
		expect(snapshotOf(tool)).toEqual(golden)
	})

	it("has no orphaned golden files (tool removed but snapshot left behind)", () => {
		if (!existsSync(SCHEMA_DIR)) return
		const goldens = readdirSync(SCHEMA_DIR)
			.filter((f) => f.endsWith(".json"))
			.map((f) => f.replace(/\.json$/, ""))
		const live = new Set(fnTools.map((t) => t.function.name))
		const orphans = goldens.filter((g) => !live.has(g))
		expect(orphans, `orphaned golden(s): ${orphans.join(", ")} — delete or run UPDATE_TOOL_SCHEMAS=1`).toEqual([])
	})
})
