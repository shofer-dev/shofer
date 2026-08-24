/**
 * On-demand schema loading: the STUB tier of a mode's tool surface.
 *
 * # The problem
 *
 * Every tool a mode admits is serialized into the tools array of every request,
 * and the array is re-sent and re-attended on every turn. A chat-shaped agent
 * fronting a large MCP catalog therefore pays for ~80 full JSON schemas per turn
 * to call two of them — in bytes, in the model's attention, and in
 * tool-selection accuracy.
 *
 * # The shape of the answer
 *
 * Three tiers, declared by the mode (`ModeConfig.tools_full_schema`):
 *
 *   1. **full schema** — the handful of tools the agent uses every turn;
 *   2. **stub** — everything else the mode admits: name, one line of prose, and
 *      a parameter schema carrying a single declared escape hatch,
 *      `arguments_json`. A stub is still an ordinary, individually callable
 *      entry in the tools array, so the model needs no dispatcher and no new
 *      calling convention;
 *   3. **discovery** — `describe_tools(names[])`, which returns the real
 *      contracts from the definitions this build already holds.
 *
 * # Why a stub declares a property instead of declaring none
 *
 * The obvious stub schema is the permissive empty object —
 * `{type: "object", properties: {}, additionalProperties: true}` — and it is
 * WRONG for a whole class of providers. Moonshot/Kimi and MiniMax decode tool
 * arguments under a grammar compiled from the DECLARED schema, so a schema with
 * no properties admits exactly one output: `{}`. The constraint outranks the
 * stub's prose, and it outranks the `describe_tools` result riding the message
 * stream — the model has read the real contract and still cannot emit it. There
 * is no self-heal, so every call to every stubbed tool is invalid, forever
 * (observed live: an orchestrator burning its retry budget on precisely its
 * stubbed tools while every full-schema sibling worked).
 *
 * Upgrading the stub to the real schema after discovery is not available either
 * — see the byte-stability constraint below. So the stub declares ONE string
 * property the model puts the real arguments into, JSON-encoded, which every
 * constrained decoder can express. `additionalProperties` stays open and nothing
 * is `required`, so a provider that lets the model emit direct arguments keeps
 * doing exactly that, and a zero-argument call may still legitimately send `{}`.
 * `NativeToolCallParser` unwraps `arguments_json` back into ordinary arguments
 * before any validation runs, so nothing downstream of the parser learns the
 * hatch exists.
 *
 * # Two constraints this file exists to satisfy
 *
 * **The tools array must stay byte-stable per (bundle, mode).** It serializes
 * into the provider's cached prefix, so a schema fetched mid-conversation may
 * never be injected back into it — that would invalidate the cache on every
 * discovery, costing far more than the schemas save. A stub is therefore derived
 * deterministically from the tool's own definition, and `describe_tools` answers
 * through the message stream, which is append-only and cache-safe. This is also
 * why the hatch is a constant: it costs the same bytes in every stub of every
 * build.
 *
 * **A stub weakens no validation.** It changes only what the model is SHOWN.
 * Execution still runs the tool's real contract — against the UNWRAPPED
 * arguments: a native tool's handler raises its own missing-parameter error (or
 * its parser rejects the call as unparseable when a required argument it guards
 * on is absent), a plugin tool's arguments are parsed against its Zod schema at
 * dispatch, and an MCP tool's arguments are validated by the server that owns it.
 * That is also the self-healing path when the model skips discovery — it gets the
 * normal validation error and can react to it.
 */

import type OpenAI from "openai"
import type { ModeConfig } from "@shofer/types"
import {
	DESCRIBE_TOOLS_TOOL_NAME,
	STUB_ARGUMENTS_JSON_PARAM,
	isFullSchemaTool,
	modeStubsToolSchemas,
} from "@shofer/types"

/**
 * How much of a tool's own description survives into its stub. Long enough to
 * tell two tools of the same family apart, short enough that 50 stubs cost less
 * than one full schema.
 */
const STUB_DESCRIPTION_MAX = 180

/**
 * The instruction appended to every stub. It names the discovery tool, says
 * plainly that the parameters are missing (a model shown a schema with one
 * property otherwise concludes that property IS the contract), and names the
 * hatch. Every byte here is paid once per stub, so the protocol is explained at
 * length in the system prompt's TOOL USE section instead — this is the reminder.
 */
const STUB_SUFFIX = `Parameters omitted: call ${DESCRIBE_TOOLS_TOOL_NAME} for the real contract, then pass those arguments JSON-encoded in ${STUB_ARGUMENTS_JSON_PARAM}.`

/** The one-line description of the hatch, carried in every stub's schema. */
const STUB_ARGUMENTS_JSON_DESCRIPTION = `This tool's real arguments as a JSON-encoded object, e.g. "{\\"path\\": \\"src/app.ts\\"}". Get the contract from ${DESCRIBE_TOOLS_TOOL_NAME} first.`

/**
 * The parameter schema every stub carries: one declared string property, and
 * nothing required.
 *
 * The property is what makes a stub callable at all on a provider that decodes
 * tool arguments under a grammar built from the schema (Moonshot/Kimi, MiniMax) —
 * see this file's header. `additionalProperties` stays open so a model that
 * already knows the contract, and a provider that lets it emit the arguments
 * directly, need no hatch and no second round trip. Nothing is `required`,
 * because a zero-argument tool may legitimately be called with `{}`; what the
 * arguments must satisfy is decided at execution, against the tool's real
 * contract.
 *
 * Deliberately NOT `strict`: OpenAI strict mode requires every property to be
 * declared and `additionalProperties: false`, which is the opposite of a stub.
 *
 * Frozen at every level: one object is shared by every stub in every request, so
 * a mutation would rewrite the cached prefix of every conversation at once.
 */
const STUB_PARAMETERS = Object.freeze({
	type: "object",
	properties: Object.freeze({
		[STUB_ARGUMENTS_JSON_PARAM]: Object.freeze({
			type: "string",
			description: STUB_ARGUMENTS_JSON_DESCRIPTION,
		}),
	}),
	additionalProperties: true,
}) as unknown as OpenAI.FunctionParameters

/** Function name of a tool definition (every definition here is a function). */
function toolName(tool: OpenAI.Chat.ChatCompletionTool): string {
	return (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name
}

/**
 * The first sentence of a description, capped. Whitespace is collapsed so a
 * multi-line description does not smuggle a paragraph into the stub, and the cap
 * cuts at a word boundary rather than mid-token.
 */
export function summarizeToolDescription(description: string | undefined, name: string): string {
	const flat = (description ?? "").replace(/\s+/g, " ").trim()
	if (!flat) {
		return name
	}
	const sentenceEnd = flat.search(/\.\s/)
	const firstSentence = sentenceEnd > 0 ? flat.slice(0, sentenceEnd + 1) : flat
	if (firstSentence.length <= STUB_DESCRIPTION_MAX) {
		return firstSentence
	}
	const cut = firstSentence.slice(0, STUB_DESCRIPTION_MAX)
	const lastSpace = cut.lastIndexOf(" ")
	return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/**
 * Reduce one tool definition to its stub. Pure and deterministic: the same
 * definition always yields the same bytes, which is what keeps the tools array
 * stable across turns.
 */
export function stubToolDefinition(tool: OpenAI.Chat.ChatCompletionTool): OpenAI.Chat.ChatCompletionTool {
	const fn = (tool as OpenAI.Chat.ChatCompletionFunctionTool).function
	return {
		type: "function",
		function: {
			name: fn.name,
			description: `${summarizeToolDescription(fn.description, fn.name)} ${STUB_SUFFIX}`,
			parameters: STUB_PARAMETERS,
		},
	}
}

/** What `applyToolSchemaTiers` produced, for logging and for `describe_tools`. */
export interface ToolSchemaTiers {
	/** The tools as the model will see them: full schemas plus stubs. */
	tools: OpenAI.Chat.ChatCompletionTool[]
	/** Names that were reduced to a stub (empty when the mode declares no tiering). */
	stubbed: string[]
}

/**
 * Split an already-mode-filtered tool array into the full-schema and stub tiers.
 *
 * A mode that declares no `tools_full_schema` is returned its own array,
 * untouched and by identity — the default path must be byte-for-byte what it was
 * before this file existed.
 */
export function applyToolSchemaTiers(
	tools: OpenAI.Chat.ChatCompletionTool[],
	mode: Pick<ModeConfig, "tools_full_schema">,
): ToolSchemaTiers {
	if (!modeStubsToolSchemas(mode)) {
		return { tools, stubbed: [] }
	}

	const stubbed: string[] = []
	const tiered = tools.map((tool) => {
		const name = toolName(tool)
		if (isFullSchemaTool(mode, name)) {
			return tool
		}
		stubbed.push(name)
		return stubToolDefinition(tool)
	})

	return { tools: tiered, stubbed }
}
