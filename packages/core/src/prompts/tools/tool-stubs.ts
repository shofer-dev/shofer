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
 *      a permissive `object` parameter schema. A stub is still an ordinary,
 *      individually callable entry in the tools array, so the model needs no
 *      dispatcher and no new calling convention;
 *   3. **discovery** — `describe_tools(names[])`, which returns the real
 *      contracts from the definitions this build already holds.
 *
 * # Two constraints this file exists to satisfy
 *
 * **The tools array must stay byte-stable per (bundle, mode).** It serializes
 * into the provider's cached prefix, so a schema fetched mid-conversation may
 * never be injected back into it — that would invalidate the cache on every
 * discovery, costing far more than the schemas save. A stub is therefore derived
 * deterministically from the tool's own definition, and `describe_tools` answers
 * through the message stream, which is append-only and cache-safe.
 *
 * **A stub weakens no validation.** It changes only what the model is SHOWN.
 * Execution still runs the tool's real contract: a native tool's handler raises
 * its own missing-parameter error (or its parser rejects the call as unparseable
 * when a required argument it guards on is absent), a plugin tool's arguments are
 * parsed against its Zod schema at dispatch, and an MCP tool's arguments are
 * validated by the server that owns it. That is also the self-healing path when
 * the model skips discovery — it gets the normal validation error and can react
 * to it.
 */

import type OpenAI from "openai"
import type { ModeConfig } from "@shofer/types"
import { DESCRIBE_TOOLS_TOOL_NAME, isFullSchemaTool, modeStubsToolSchemas } from "@shofer/types"

/**
 * How much of a tool's own description survives into its stub. Long enough to
 * tell two tools of the same family apart, short enough that 50 stubs cost less
 * than one full schema.
 */
const STUB_DESCRIPTION_MAX = 180

/**
 * The instruction appended to every stub. It names the discovery tool and says
 * plainly that the parameters are missing, because a model shown an empty
 * `properties` map otherwise concludes the tool takes no arguments.
 */
const STUB_SUFFIX = `Parameters omitted: call ${DESCRIBE_TOOLS_TOOL_NAME} with this tool's name for its full argument contract before calling it.`

/**
 * The permissive parameter schema every stub carries. `additionalProperties`
 * stays open so a model that already knows the contract (from `describe_tools`,
 * or from earlier in the conversation) can call the tool without a second
 * round trip; the real schema is enforced at execution regardless.
 *
 * Deliberately NOT `strict`: OpenAI strict mode requires every property to be
 * declared and `additionalProperties: false`, which is the opposite of a stub.
 */
const STUB_PARAMETERS = Object.freeze({
	type: "object",
	properties: {},
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
