import type OpenAI from "openai"
import { type ToolUse } from "@shofer/types"

import { Task } from "../task/Task.js"
import { BaseTool, ToolCallbacks } from "./BaseTool.js"
import { knownToolNames, lookupToolSchema } from "./tool-schema-registry.js"

/** Arguments as the parser hands them over. */
interface DescribeToolsParams {
	names: string[]
}

/** One described tool, as it goes back to the model. */
interface DescribedTool {
	name: string
	description?: string
	parameters?: unknown
}

/**
 * How many alternative names an unknown request is answered with. Enough to
 * catch a typo or a half-remembered family name; short enough that a mistake
 * does not cost a catalog dump.
 */
const SUGGESTION_LIMIT = 12

/**
 * Rank known names by how plausibly they are what an unknown name meant:
 * a shared prefix or an infix match first, then a shared leading token
 * (`vms_` / `mcp--server--`), then everything else in catalog order.
 */
export function suggestToolNames(unknown: string, known: readonly string[], limit = SUGGESTION_LIMIT): string[] {
	const needle = unknown.toLowerCase()
	const token = needle.split(/[^a-z0-9]+/).filter(Boolean)[0] ?? needle
	const scored = known
		.map((name) => {
			const candidate = name.toLowerCase()
			if (candidate.includes(needle) || needle.includes(candidate)) return { name, score: 0 }
			if (token && candidate.includes(token)) return { name, score: 1 }
			return { name, score: 2 }
		})
		.filter((entry) => entry.score < 2)
		.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
	return scored.slice(0, limit).map((entry) => entry.name)
}

/**
 * `describe_tools` — hand the model the full contract of tools it was shown as
 * stubs.
 *
 * Answered entirely from the definitions the current tool build recorded
 * (`tool-schema-registry.ts`), which is what makes it free: no MCP round trip,
 * no catalog fetch, and no possibility of describing a contract that differs
 * from the one the call will be validated against. The result rides back as an
 * ordinary tool result — the message stream is append-only, so unlike injecting
 * the schema into the request's tools array it costs no prompt-cache prefix.
 *
 * Unknown names never fail the call: the model is told which of the names it
 * asked for do not exist, given the nearest known names, and still receives the
 * schemas of the names that do — a failed lookup must not cost the whole batch.
 */
export class DescribeToolsTool extends BaseTool<"describe_tools"> {
	readonly name = "describe_tools" as const

	async execute(params: DescribeToolsParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult } = callbacks

		const requested = Array.isArray(params?.names) ? params.names.filter((n) => typeof n === "string" && n) : []
		if (requested.length === 0) {
			task.consecutiveMistakeCount++
			task.recordToolError("describe_tools")
			pushToolResult(await task.sayAndCreateMissingParamError("describe_tools", "names"))
			return
		}
		task.consecutiveMistakeCount = 0

		const modeSlug = await task.getTaskMode()
		const known = knownToolNames(modeSlug)

		const described: DescribedTool[] = []
		const unknown: string[] = []
		for (const name of requested) {
			const tool = lookupToolSchema(modeSlug, name)
			if (tool) {
				described.push(describe(tool))
			} else {
				unknown.push(name)
			}
		}

		const didApprove = await this.askToolApproval(callbacks, {
			tool: "describeTools",
			content: requested.join(", "),
		})
		if (!didApprove) {
			return
		}

		pushToolResult(renderResult(described, unknown, known))
	}

	override async handlePartial(task: Task, block: ToolUse<"describe_tools">): Promise<void> {
		await task.ask("tool", JSON.stringify({ tool: "describeTools" }), block.partial).catch(() => {})
	}
}

/** Reduce a stored definition to the three fields the model needs. */
function describe(tool: OpenAI.Chat.ChatCompletionFunctionTool): DescribedTool {
	return {
		name: tool.function.name,
		description: tool.function.description,
		parameters: tool.function.parameters,
	}
}

/**
 * The tool result. Schemas first (that is what was asked for), then — only when
 * something was missed — the names that do not exist and the closest ones that
 * do, so the model can retry without a second discovery round.
 */
function renderResult(described: DescribedTool[], unknown: string[], known: readonly string[]): string {
	const parts: string[] = []
	if (described.length > 0) {
		parts.push(JSON.stringify({ tools: described }, null, 2))
	}
	for (const name of unknown) {
		const suggestions = suggestToolNames(name, known)
		parts.push(
			suggestions.length > 0
				? `No tool named "${name}" is available in this mode. Closest available names: ${suggestions.join(", ")}.`
				: `No tool named "${name}" is available in this mode.`,
		)
	}
	if (described.length === 0 && unknown.length > 0) {
		parts.push(
			known.length > 0
				? `Every tool available to you is listed in your tool definitions; the full set is: ${known.join(", ")}.`
				: `No tool definitions have been built for this mode yet.`,
		)
	}
	return parts.join("\n\n")
}

export const describeToolsTool = new DescribeToolsTool()
