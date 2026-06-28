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
	/**
	 * Whether to emit OpenAI strict mode (default `true`). When `true`, the schema
	 * is pre-baked into strict form (every property required, optionals widened to
	 * nullable). Set `false` for tools that deliberately let the model omit
	 * advisory parameters (e.g. `send_message_to_task`): `strict: false` is set and
	 * optional properties stay omitted from `required` and are NOT widened.
	 */
	strict?: boolean
}

/** A native tool carrying its Zod schema alongside the OpenAI definition. */
export type DefinedNativeTool<S extends ZodType> = OpenAI.Chat.ChatCompletionFunctionTool & {
	/** The Zod schema this tool was defined from (for arg-type inference / validation). */
	readonly schema: S
}

/** Static argument type inferred from a defined tool's Zod schema. */
export type NativeToolArgsOf<T> = T extends DefinedNativeTool<infer S> ? zt.infer<S> : never

type JsonSchemaProp = {
	type?: string | string[]
	enum?: unknown[]
	[k: string]: unknown
}

/**
 * Make an optional property nullable-required, reproducing the OpenAI-strict
 * convention the hand-written native tools used: every property appears in
 * `required`, and a property that was *optional* in the Zod schema is widened to
 * accept `null` (`type: ["x","null"]`, and `null` appended to any `enum`) so the
 * model can signal "not provided". This keeps the raw schema byte-compatible with
 * the pre-migration definitions for ALL providers (not only the OpenAI-strict
 * path, which would normalize it anyway).
 */
function makeNullable(prop: JsonSchemaProp): JsonSchemaProp {
	const next: JsonSchemaProp = { ...prop }
	if (Array.isArray(next.enum) && !next.enum.includes(null)) {
		next.enum = [...next.enum, null]
	}
	if (typeof next.type === "string") {
		next.type = [next.type, "null"]
	} else if (Array.isArray(next.type) && !next.type.includes("null")) {
		next.type = [...next.type, "null"]
	}
	return next
}

/**
 * Build a `ChatCompletionFunctionTool` from a single Zod schema.
 *
 * The emitted JSON Schema is pre-baked into OpenAI strict form — `$schema`
 * stripped, `additionalProperties: false`, every property in `required`, and
 * optional properties widened to nullable — so it matches the hand-written tool
 * schemas this helper replaces (verified by the golden-snapshot test). `strict:
 * true` is set; the provider layer's `convertToolSchemaForOpenAI` is then a
 * no-op for these tools.
 */
export function defineNativeTool<S extends ZodType>(spec: NativeToolSpec<S>): DefinedNativeTool<S> {
	const strict = spec.strict ?? true
	const json = z.toJSONSchema(spec.schema, { io: "input" }) as Record<string, unknown>
	delete json.$schema

	if (json.type === "object") {
		json.additionalProperties = false
		// In strict mode every property must appear in `required`; optionals are
		// widened to nullable so the model can still signal "not provided". When
		// strict is off, optionals stay omitted from `required` and are not widened
		// (the model may omit them entirely).
		if (strict) {
			const properties = (json.properties as Record<string, JsonSchemaProp> | undefined) ?? {}
			const allKeys = Object.keys(properties)
			const required = new Set((json.required as string[] | undefined) ?? [])
			for (const key of allKeys) {
				if (!required.has(key)) {
					properties[key] = makeNullable(properties[key])
				}
			}
			json.required = allKeys
		}
	}

	return {
		type: "function",
		function: {
			name: spec.name,
			description: spec.description,
			strict,
			parameters: json as OpenAI.FunctionParameters,
		},
		schema: spec.schema,
	}
}
