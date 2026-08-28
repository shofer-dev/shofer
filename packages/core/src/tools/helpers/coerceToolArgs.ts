/**
 * Schema-driven coercion of stringified scalars in custom-tool arguments.
 *
 * Providers do not agree on how a tool call's scalar arguments are encoded. Most
 * emit JSON scalars, but several stringify everything — `"wake": "true"` instead
 * of `true`, `"ttl_sec": "300"` instead of `300` — and a tool called through the
 * stub escape hatch is worse still: the model hand-writes the JSON for
 * `arguments_json`, so a quoted number is a coin toss on every call.
 *
 * NATIVE tools have always absorbed this by hand, per tool and per parameter
 * (`parseToolBoolean`, `coerceOptionalNumber`, the `"true"` checks scattered
 * through the parser's switches). Custom tools — every plugin-contributed tool —
 * had nothing: their arguments go straight to `schema.parse()`, so a stringified
 * scalar was a hard validation failure that the model saw as a tool error with no
 * hint about what to change. This closes that gap once, generically, from the
 * schema itself, so no plugin has to think about it.
 *
 * **It only ever narrows a string to the type the schema already asks for.** It
 * never invents a value, never fills in a missing key, never touches an object,
 * an enum or a declared string, and never widens a type. A value it cannot
 * confidently convert is passed through unchanged, so the schema still rejects it
 * and the model still gets a real validation error.
 *
 * Zod version: written against the `zod/v4` API that `@shofer/types` re-exports
 * as `parametersSchema` (zod 3.25.76 ships v4 on that subpath). A schema whose
 * internals do not match that shape — anything this cannot introspect — makes the
 * whole call a passthrough rather than a guess.
 */

/** The wrapper kinds that hold their real schema in `def.innerType`. */
const INNER_TYPE_WRAPPERS = new Set(["optional", "nullable", "default", "nonoptional", "readonly", "catch"])

/** A zod/v4 schema node, read structurally so no zod type import is needed. */
interface SchemaNode {
	def?: {
		type?: string
		innerType?: SchemaNode
		element?: SchemaNode
		in?: SchemaNode
		shape?: Record<string, SchemaNode>
	}
}

/**
 * Strip the wrappers that do not change the underlying primitive type.
 *
 * `z.boolean().optional().nullable()` still asks for a boolean, and so does
 * `z.number().default(0)`. A `pipe` (what `.transform()` produces in v4) is
 * unwrapped to its INPUT side, because the input is what the raw arguments are
 * validated against. Bounded against a pathological self-referential schema.
 */
function unwrap(schema: SchemaNode | undefined): SchemaNode | undefined {
	let current = schema
	for (let depth = 0; current?.def && depth < 10; depth++) {
		const { type } = current.def
		if (type && INNER_TYPE_WRAPPERS.has(type) && current.def.innerType) {
			current = current.def.innerType
			continue
		}
		if (type === "pipe" && current.def.in) {
			current = current.def.in
			continue
		}
		return current
	}
	return current
}

/**
 * `"true"` / `"false"` (case-insensitive, surrounding whitespace ignored) become
 * booleans. Every other value — including `"yes"`, `"1"` and a real boolean —
 * is returned untouched: `1` is a plausible number and `"yes"` is a plausible
 * string, and guessing either would be inventing an argument.
 */
function coerceBoolean(value: unknown): unknown {
	if (typeof value !== "string") {
		return value
	}
	const normalized = value.trim().toLowerCase()
	if (normalized === "true") return true
	if (normalized === "false") return false
	return value
}

/**
 * A string that parses as a FINITE number becomes that number. An empty or
 * whitespace-only string is not a number (`Number("")` is `0`, which would be a
 * fabricated value), and `Infinity`/`NaN` are refused for the same reason.
 */
function coerceNumber(value: unknown): unknown {
	if (typeof value !== "string") {
		return value
	}
	const trimmed = value.trim()
	if (trimmed === "") {
		return value
	}
	const parsed = Number(trimmed)
	return Number.isFinite(parsed) ? parsed : value
}

/** Coerce one value against one already-unwrapped field schema. */
function coerceValue(fieldSchema: SchemaNode | undefined, value: unknown): unknown {
	const type = fieldSchema?.def?.type
	if (type === "boolean") {
		return coerceBoolean(value)
	}
	if (type === "number") {
		return coerceNumber(value)
	}
	if (type === "array" && Array.isArray(value)) {
		// Arrays of primitives only: each element is coerced by the same rules as a
		// top-level scalar. An array of objects is left entirely alone.
		const element = unwrap(fieldSchema?.def?.element)
		const elementType = element?.def?.type
		if (elementType !== "boolean" && elementType !== "number") {
			return value
		}
		let elementChanged = false
		const mapped = value.map((item) => {
			const next = elementType === "boolean" ? coerceBoolean(item) : coerceNumber(item)
			if (next !== item) {
				elementChanged = true
			}
			return next
		})
		return elementChanged ? mapped : value
	}
	return value
}

/** A plain object — not an array, not null, not a class instance we should touch. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Return `args` with stringified booleans and numbers narrowed to the types
 * `schema` declares for them.
 *
 * Top-level keys only, deliberately: a nested object's contract belongs to
 * whatever produced it, and walking arbitrarily deep would turn a narrow
 * compatibility shim into a general-purpose value rewriter.
 *
 * @param schema The tool's `parameters` schema. Anything that is not an
 * introspectable zod/v4 object schema makes this a passthrough.
 * @param args The raw arguments from the tool call.
 * @returns A NEW object when something changed, otherwise `args` unchanged.
 */
export function coerceCustomToolArgs(schema: unknown, args: unknown): unknown {
	if (!isPlainObject(args)) {
		return args
	}

	const shape = unwrap(schema as SchemaNode | undefined)?.def?.shape
	if (!shape || typeof shape !== "object") {
		return args
	}

	let changed = false
	const coerced: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(args)) {
		// A key the schema does not declare is passed through verbatim — the schema
		// decides what to do about it, not this.
		const fieldSchema = Object.prototype.hasOwnProperty.call(shape, key) ? unwrap(shape[key]) : undefined
		const next = fieldSchema ? coerceValue(fieldSchema, value) : value
		if (next !== value) {
			changed = true
		}
		coerced[key] = next
	}

	return changed ? coerced : args
}
