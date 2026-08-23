// Byte measurement of the request's TOOLS ARRAY, full-schema versus stubbed.
//
// Run it for the numbers (vitest is silent by default, so `--no-silent` is what
// makes the table appear):
//
//   npx vitest run --no-silent packages/core/src/prompts/tools/__tests__/tool-array-bytes.spec.ts
//
// # Why this sits beside the system-prompt harness
//
// `prompts/__tests__/section-bytes.spec.ts` measures the other half of the
// request head, and the two answer one question together: where the bytes of a
// turn actually are. For a chat-shaped agent fronting a large MCP catalog the
// answer is not the prompt — the tool array is several times its size, and it is
// re-sent and re-attended on EVERY turn.
//
// # Measuring an external catalog
//
// The MCP catalog of a deployment does not live in this repo, so the fixture
// here is a synthetic one whose per-tool size is stated rather than assumed. To
// measure a REAL one, point the harness at a JSON array of
// `{ name, description, inputSchema }` (an MCP `tools/list` payload, or a dump of
// whatever produces it):
//
//   TOOL_ARRAY_CATALOG=/path/to/catalog.json npx vitest run --no-silent \
//     packages/core/src/prompts/tools/__tests__/tool-array-bytes.spec.ts
//
// # What it also guards
//
// The assertions are the regression net the printed table cannot be: stubbing
// must SAVE most of the catalog's bytes (a stub that grew a schema back would
// still print a table), and it must leave the always-on tier untouched to the
// byte, since that tier is part of the cached request prefix.

import { readFileSync } from "fs"

import type OpenAI from "openai"
import type { ModeConfig } from "@shofer/types"

import { applyToolSchemaTiers } from "../tool-stubs.js"
import { filterNativeToolsForMode } from "../filter-tools-for-mode.js"
import { getNativeTools } from "../native-tools/index.js"
import { buildMcpToolName } from "../../../utils/mcp-name.js"

/** The tools a chat-shaped orchestrator calls every turn — the full-schema tier. */
const ALWAYS_ON = [
	"attempt_completion",
	"ask_followup_question",
	"skills",
	"set_task_title",
	"new_task",
	"update_todo_list",
	"send_message_to_task",
	"wait_for_message",
	"check_task_status",
	"describe_tools",
]

/**
 * A chat-shaped mode: the MCP catalog plus questions and subtasks, and no native
 * file or shell tool (empty exclusive allow-lists keep the group names on the
 * mode, which is what exposes the catalog).
 */
const CHAT_MODE: ModeConfig = {
	slug: "orchestrator",
	name: "Orchestrator",
	roleDefinition: "You operate a platform and delegate work; you edit no files.",
	tools: ["mcp", "questions", "subtasks", { read: { allowed: [] } }, { write: { allowed: [] } }],
	tools_denied: ["call_mcp_tool_async", "check_mcp_call_status", "wait_for_mcp_call", "access_mcp_resource"],
}

const TIERED_MODE: ModeConfig = { ...CHAT_MODE, tools_full_schema: ALWAYS_ON }

interface CatalogEntry {
	name: string
	description: string
	inputSchema: unknown
}

/**
 * A synthetic MCP catalog: 48 verb-multiplexing noun tools, each with an
 * `operation` enum and a handful of documented arguments — the shape a
 * control-plane catalog has when it follows "one tool per noun, verb in an
 * enum". Sized to ~1.6 KB per tool, which is what a real catalog of this shape
 * measures once every operation and argument carries the prose an agent needs to
 * pick between them.
 */
function syntheticCatalog(): CatalogEntry[] {
	const operations = ["list", "get", "create", "update", "delete"]
	return Array.from({ length: 48 }, (_, i) => ({
		name: `noun_${i}`,
		description:
			`Manage noun ${i}: ${operations.join(", ")}. ` +
			`Every operation is authorized server-side against the caller's membership of the project the object belongs to, ` +
			`so a call that would exceed the caller's rights is refused rather than silently narrowed. ` +
			`Prefer the narrowest operation that answers the question, and read before you write.`,
		inputSchema: {
			type: "object",
			properties: {
				operation: {
					type: "string",
					enum: operations,
					description: operations
						.map((op) => `"${op}": ${op} noun ${i} — see the arguments each operation requires below.`)
						.join(" "),
				},
				id: {
					type: "string",
					description: `Identifier of the noun ${i} object. Required for get, update and delete; ignored by list and create.`,
				},
				project_id: {
					type: "string",
					description: "Project the object belongs to. Required for create; narrows list when given.",
				},
				body: {
					type: "object",
					description: "Payload for create and update. Fields not named are left as they were.",
				},
				page_size: { type: "integer", description: "Maximum rows returned by list. Defaults to 50." },
			},
			required: ["operation"],
		},
	}))
}

function loadCatalog(): { entries: CatalogEntry[]; source: string } {
	const path = process.env.TOOL_ARRAY_CATALOG
	if (!path) {
		return { entries: syntheticCatalog(), source: "synthetic 48-noun catalog" }
	}
	return { entries: JSON.parse(readFileSync(path, "utf8")) as CatalogEntry[], source: path }
}

function asMcpTools(entries: CatalogEntry[], server: string): OpenAI.Chat.ChatCompletionTool[] {
	return entries.map((entry) => ({
		type: "function",
		function: {
			name: buildMcpToolName(server, entry.name),
			description: entry.description,
			parameters: entry.inputSchema as OpenAI.FunctionParameters,
		},
	}))
}

const bytes = (tools: OpenAI.Chat.ChatCompletionTool[]) => Buffer.byteLength(JSON.stringify(tools))
const nameOf = (tool: OpenAI.Chat.ChatCompletionTool) => (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name

describe("tools array: bytes before and after stubbing", () => {
	const { entries, source } = loadCatalog()
	const mcpTools = asMcpTools(entries, "platform")

	/** The array as built for a mode, in the order the builder concatenates it. */
	function arrayFor(mode: ModeConfig): OpenAI.Chat.ChatCompletionTool[] {
		const native = filterNativeToolsForMode(getNativeTools(), mode.slug, [mode], {}, {})
		return applyToolSchemaTiers([...native, ...mcpTools], mode).tools
	}

	it("prints the full-schema and stubbed sizes of the same tool surface", () => {
		const full = arrayFor(CHAT_MODE)
		const tiered = arrayFor(TIERED_MODE)

		const fullNative = full.filter((t) => !nameOf(t).startsWith("mcp--"))
		const tieredNative = tiered.filter((t) => !nameOf(t).startsWith("mcp--"))
		const tieredMcp = tiered.filter((t) => nameOf(t).startsWith("mcp--"))

		const rows = [
			["native tools", fullNative.length, bytes(fullNative), tieredNative.length, bytes(tieredNative)],
			["MCP catalog", mcpTools.length, bytes(mcpTools), tieredMcp.length, bytes(tieredMcp)],
			["TOTAL", full.length, bytes(full), tiered.length, bytes(tiered)],
		] as const

		const lines = [
			"",
			`tools array (catalog: ${source}; ${ALWAYS_ON.length} tools in the full-schema tier)`,
			`  ${"".padEnd(14)}  ${"tools".padStart(5)}  ${"full".padStart(8)}  ${"stubbed".padStart(8)}  saved`,
			...rows.map(
				([label, count, fullBytes, , stubBytes]) =>
					`  ${label.padEnd(14)}  ${String(count).padStart(5)}  ${String(fullBytes).padStart(8)}  ${String(stubBytes).padStart(8)}  ` +
					`${(((fullBytes - stubBytes) / fullBytes) * 100).toFixed(1).padStart(5)}%`,
			),
			"",
		]
		console.log(lines.join("\n"))

		// Stubbing must not change WHICH tools are callable — only how much of each
		// contract is sent. (One more on the tiered side: describe_tools, which a
		// mode without stubs is not offered.)
		expect(tiered.length).toBe(full.length + 1)
		// The saving is the whole point, and it is the CATALOG where it lands: the
		// full-schema tier is deliberately the expensive handful the agent uses
		// every turn, so the total saving is bounded by how much of the surface is
		// stubbable. Less than half off the catalog means a stub grew a schema back.
		expect(bytes(tieredMcp)).toBeLessThan(bytes(mcpTools) / 2)
		expect(bytes(tiered)).toBeLessThan(bytes(full))
	})

	it("leaves every full-schema tool byte-identical — it is part of the cached prefix", () => {
		const full = arrayFor(CHAT_MODE)
		const tiered = arrayFor(TIERED_MODE)
		for (const name of ALWAYS_ON) {
			const before = full.find((t) => nameOf(t) === name)
			const after = tiered.find((t) => nameOf(t) === name)
			if (name === "describe_tools") {
				expect(before, "describe_tools must not be offered without stubs").toBeUndefined()
				expect(after, "describe_tools must be offered with stubs").toBeDefined()
				continue
			}
			expect(JSON.stringify(after), `${name} changed`).toEqual(JSON.stringify(before))
		}
	})

	it("is byte-stable across builds — a turn-varying tools array would cost the cache", () => {
		expect(JSON.stringify(arrayFor(TIERED_MODE))).toEqual(JSON.stringify(arrayFor(TIERED_MODE)))
	})
})
