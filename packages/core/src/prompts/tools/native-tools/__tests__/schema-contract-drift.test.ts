import { describe, it, expect } from "vitest"
import type OpenAI from "openai"

import { TOOL_GROUPS, ALWAYS_AVAILABLE_TOOLS, TOOL_DISPLAY_NAMES, toolNames } from "@shofer/types"
import { toolParamNames } from "@shofer/types"
import { getNativeTools } from "../index.js"

/**
 * Schema-as-contract drift guard (v3 architecture §3).
 *
 * A tool's shape is currently re-declared across several independent sources of
 * truth: the JSON schema in `native-tools/*.ts`, the `toolNames` enum and
 * `TOOL_GROUPS`/`TOOL_DISPLAY_NAMES` in `@shofer/types`, and the parser's
 * `toolParamNames` whitelist in `shared/tools.ts`. When these drift, a tool can
 * be half-registered and fail *silently* — most notably, a parameter present in
 * a tool's JSON schema but absent from `toolParamNames` is dropped by the parser
 * before the handler ever sees it.
 *
 * Until each tool is a single typed schema object (the strangler target), this
 * test makes that drift fail *loudly* at build time. The function definitions
 * sent to the model (`getNativeTools()`) are the canonical shape; every other
 * declaration site is checked against them.
 */

type FnTool = OpenAI.Chat.ChatCompletionFunctionTool

const fnTools = (): FnTool[] =>
	getNativeTools({ supportsImages: true }).filter((t): t is FnTool => (t as FnTool).type === "function")

const toolNameOf = (t: FnTool) => t.function.name

const topLevelParams = (t: FnTool): string[] => {
	const params = t.function.parameters as { properties?: Record<string, unknown> } | undefined
	return Object.keys(params?.properties ?? {})
}

describe("schema-as-contract drift guard", () => {
	it("every native tool name is declared in the toolNames enum", () => {
		const known = new Set<string>(toolNames)
		const missing = fnTools()
			.map(toolNameOf)
			.filter((name) => !known.has(name))
		expect(missing, `tool(s) not in @shofer/types toolNames enum: ${missing.join(", ")}`).toEqual([])
	})

	it("every native tool has a human-readable display name", () => {
		const missing = fnTools()
			.map(toolNameOf)
			.filter((name) => !(name in TOOL_DISPLAY_NAMES))
		expect(missing, `tool(s) missing from TOOL_DISPLAY_NAMES: ${missing.join(", ")}`).toEqual([])
	})

	it("every native tool is classified into a group or is always-available", () => {
		const grouped = new Set<string>()
		for (const cfg of Object.values(TOOL_GROUPS)) {
			for (const t of cfg.tools) grouped.add(t)
			for (const t of cfg.customTools ?? []) grouped.add(t)
		}
		const always = new Set<string>(ALWAYS_AVAILABLE_TOOLS)
		const unclassified = fnTools()
			.map(toolNameOf)
			.filter((name) => !grouped.has(name) && !always.has(name))
		expect(
			unclassified,
			`tool(s) not in any TOOL_GROUP nor ALWAYS_AVAILABLE_TOOLS (auto-approval would resolve them as "uncategorized"): ${unclassified.join(", ")}`,
		).toEqual([])
	})

	it("every JSON-schema parameter is in the parser's toolParamNames whitelist", () => {
		// This is the highest-value guard: a property declared in a tool's JSON
		// schema but absent here is silently dropped by the tool-call parser.
		const allowed = new Set<string>(toolParamNames)
		const offenders: string[] = []
		for (const tool of fnTools()) {
			for (const param of topLevelParams(tool)) {
				if (!allowed.has(param)) {
					offenders.push(`${toolNameOf(tool)}.${param}`)
				}
			}
		}
		expect(
			offenders,
			`schema parameter(s) missing from toolParamNames (parser will silently drop them): ${offenders.join(", ")}`,
		).toEqual([])
	})

	it("native tool names are unique", () => {
		const names = fnTools().map(toolNameOf)
		const seen = new Set<string>()
		const dupes = new Set<string>()
		for (const n of names) {
			if (seen.has(n)) dupes.add(n)
			seen.add(n)
		}
		expect([...dupes], `duplicate tool name(s) in getNativeTools(): ${[...dupes].join(", ")}`).toEqual([])
	})
})
