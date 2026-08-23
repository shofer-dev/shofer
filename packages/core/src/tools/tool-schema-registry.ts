/**
 * The full tool contracts `describe_tools` answers from.
 *
 * Every tool build (`buildNativeToolsArrayWithRestrictions`) already assembles
 * the complete, mode-filtered definitions of every tool the agent may call —
 * native, MCP, plugin and private alike — immediately BEFORE the stub tier
 * reduces most of them for the wire. Recording that array here is what lets the
 * discovery tool answer entirely client-side: no MCP round trip, no second
 * discovery pass, and no way for the described contract to disagree with the
 * contract the call will actually be validated against, because they are the
 * same object.
 *
 * Keyed by MODE, because the tool set is: two tasks running different modes on
 * one host must not read each other's catalogs. Registration is idempotent and
 * last-build-wins per mode, which is correct — a rebuild is the newer truth.
 *
 * The module-level singleton follows the existing private-tool invoke map
 * (`private-tool-registry.ts`): the tool build is the only writer, and a handler
 * has no other route to the definitions its own request was built from.
 */

import type OpenAI from "openai"

/** Per-mode map of tool name → full definition, as last built for that mode. */
const schemasByMode = new Map<string, Map<string, OpenAI.Chat.ChatCompletionFunctionTool>>()

/** Function name of a tool definition. */
function nameOf(tool: OpenAI.Chat.ChatCompletionTool): string {
	return (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name
}

/**
 * Record the FULL definitions built for a mode. Call with the pre-stub array —
 * recording the stubs would make `describe_tools` echo the very thing the caller
 * asked it to expand.
 */
export function recordToolSchemas(modeSlug: string, tools: OpenAI.Chat.ChatCompletionTool[]): void {
	const map = new Map<string, OpenAI.Chat.ChatCompletionFunctionTool>()
	for (const tool of tools) {
		if ("function" in tool && tool.function) {
			map.set(nameOf(tool), tool as OpenAI.Chat.ChatCompletionFunctionTool)
		}
	}
	schemasByMode.set(modeSlug, map)
}

/** Every tool name recorded for a mode, sorted. Empty when nothing was built yet. */
export function knownToolNames(modeSlug: string): string[] {
	return Array.from(schemasByMode.get(modeSlug)?.keys() ?? []).sort()
}

/** The recorded definition of one tool, or `undefined` if the mode never had it. */
export function lookupToolSchema(modeSlug: string, name: string): OpenAI.Chat.ChatCompletionFunctionTool | undefined {
	return schemasByMode.get(modeSlug)?.get(name)
}

/** Drop a mode's recorded definitions. Tests only — the build always overwrites. */
export function resetToolSchemas(): void {
	schemasByMode.clear()
}
