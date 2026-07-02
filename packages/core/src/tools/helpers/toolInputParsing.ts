/**
 * Utilities for parsing and normalizing tool input parameters.
 *
 * LLMs frequently send JSON-typed fields as strings (e.g., Python-style
 * "True"/"False" booleans, or numeric "0"/"1"). These helpers normalize those
 * values so tools can rely on the expected JavaScript types regardless of
 * which model produced the call.
 */

/**
 * Normalizes a tool input value to a boolean.
 *
 * Accepts the full range of representations an LLM might emit:
 *   - Native booleans:               passed through unchanged
 *   - Numeric 1 / 0:                 treated as true / false
 *   - Strings "true", "True", "yes", "1"  → true
 *   - Strings "false", "False", "no", "0" → false
 *   - null / undefined:              returns undefined (value was absent)
 *   - Any other value:               returns undefined (unrecognizable)
 *
 * @param value - Raw value received from the LLM tool call argument.
 * @returns The normalized boolean, or `undefined` when the value is absent or
 *          cannot be interpreted as a boolean.
 */
export function parseToolBoolean(value: unknown): boolean | undefined {
	if (value === undefined || value === null) {
		return undefined
	}
	if (typeof value === "boolean") {
		return value
	}
	if (typeof value === "number") {
		if (value === 1) return true
		if (value === 0) return false
		return undefined
	}
	if (typeof value === "string") {
		const lower = value.trim().toLowerCase()
		if (lower === "true" || lower === "1" || lower === "yes") return true
		if (lower === "false" || lower === "0" || lower === "no") return false
	}
	return undefined
}

/**
 * Returns true if the value was already a proper boolean (no coercion needed).
 * Useful for generating a warning when an LLM sends a non-boolean for a
 * boolean-typed parameter.
 */
export function isNativeBoolean(value: unknown): value is boolean {
	return typeof value === "boolean"
}
