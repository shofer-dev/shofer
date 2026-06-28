import { parametersSchema as z } from "@shofer/types"
import type { ZodType, z as zt } from "zod/v4"
import type OpenAI from "openai"
import type { ToolName } from "@shofer/types"

/**
 * Schema-as-contract foundation (todos/opencode_inspired_work.md §3).
 *
 * A native tool is defined ONCE as a Zod schema. From that single source we
 * derive the OpenAI function definition sent to the model (`toOpenAITool`) and
 * the static argument type (`NativeToolArgsOf`). This replaces the pattern of
 * hand-writing the JSON Schema and separately maintaining the argument type, the
 * parser whitelist entry, etc. — the drift class the §3 guard catches.
 *
 * Tools are migrated to this helper incrementally (strangler, §1): a migrated
 * tool keeps emitting a `ChatCompletionFunctionTool` that slots into the existing
 * `getNativeTools()` array unchanged. An equivalence test asserts the migrated
 * schema normalizes (under the provider's OpenAI-strict transform) to the same
 * schema the hand-written definition produced, so the model sees no change.
 */
export interface NativeToolSpec<S extends ZodType> {
	/** Canonical tool name (must be a member of the `toolNames` enum). */
	name: ToolName
	/** Description shown to the model. */
	description: string
	/** Zod object schema describing the tool's parameters. */
	schema: S
}

/** A native tool carrying its Zod schema alongside the OpenAI definition. */
export type DefinedNativeTool<S extends ZodType> = OpenAI.Chat.ChatCompletionFunctionTool & {
	/** The Zod schema this tool was defined from (for arg-type inference / validation). */
	readonly schema: S
}

/** Static argument type inferred from a defined tool's Zod schema. */
export type NativeToolArgsOf<T> = T extends DefinedNativeTool<infer S> ? zt.infer<S> : never

/**
 * Build a `ChatCompletionFunctionTool` from a single Zod schema.
 *
 * The emitted JSON Schema is cleaned of the `$schema` annotation and given
 * `additionalProperties: false`; `strict: true` is set so the provider layer
 * (`convertToolSchemaForOpenAI`) applies the OpenAI-strict normalization
 * (all-properties-required, null-stripped) at request time — exactly as it does
 * for the hand-written tools.
 */
export function defineNativeTool<S extends ZodType>(spec: NativeToolSpec<S>): DefinedNativeTool<S> {
	const json = z.toJSONSchema(spec.schema, { io: "input" }) as Record<string, unknown>
	delete json.$schema
	if (json.type === "object" && json.additionalProperties === undefined) {
		json.additionalProperties = false
	}
	return {
		type: "function",
		function: {
			name: spec.name,
			description: spec.description,
			strict: true,
			parameters: json as OpenAI.FunctionParameters,
		},
		schema: spec.schema,
	}
}
