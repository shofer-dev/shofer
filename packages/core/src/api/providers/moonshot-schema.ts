/**
 * Moonshot / Kimi "flavored JSON Schema" normalization for tool parameters.
 *
 * The Moonshot API (both the platform api.moonshot.ai and the Kimi-for-Coding
 * plane api.kimi.com/coding/v1) validates each tool's `parameters` against a
 * restricted JSON-Schema subset and rejects the whole request with
 * `400 … is not a valid moonshot flavored json schema` when a construct falls
 * outside it. Shofer's generic tool schemas (native tools, and especially MCP /
 * plugin tools whose schemas pass through untouched) routinely contain such
 * constructs — e.g. an `enum` carrying a JSON `null` alongside `type: "string"`,
 * or a nullable union `type: ["string", "null"]` — so a Kimi request that
 * includes them fails before any tokens are generated, surfacing to the user as
 * "No output generated. Check the stream for errors."
 *
 * This mirrors `normalizeMoonshotToolSchema` in the Go `llm-router` service so
 * both paths accept the same schemas. Transformations applied recursively:
 *   - `type: ["X", "null"]`      → `type: "X"` (first non-"null" entry kept).
 *   - `type: ["null"]` / "null"  → the `type` key is dropped.
 *   - `enum` entries equal to JSON `null` are removed.
 *   - Inside `anyOf`/`oneOf`, branches that normalize to an empty schema `{}`
 *     (e.g. the `{"type":"null"}` half of a nullable union after its type was
 *     stripped) are dropped; a lone survivor is collapsed into the parent.
 *
 * The input is treated as immutable: a structural clone is normalized and
 * returned, so shared/cached tool schemas are never mutated in place.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

/** Normalize a tool `parameters` JSON Schema into the Moonshot-flavored subset. */
export function normalizeMoonshotToolSchema(schema: Json): Json {
	if (schema === null || typeof schema !== "object") {
		return schema
	}
	// Clone so the original (possibly shared/cached) schema is never mutated.
	const clone = structuredClone(schema)
	return normalizeNode(clone)
}

function normalizeNode(node: Json): Json {
	if (Array.isArray(node)) {
		return node.map(normalizeNode)
	}
	if (node === null || typeof node !== "object") {
		return node
	}

	const obj = node as Record<string, Json>

	// Collapse array-typed `type` to a single primitive; drop a "null"-only type.
	if ("type" in obj) {
		const t = obj.type
		if (Array.isArray(t)) {
			const picked = t.find((entry) => typeof entry === "string" && entry !== "null")
			if (typeof picked === "string") {
				obj.type = picked
			} else {
				delete obj.type
			}
		} else if (t === "null") {
			delete obj.type
		}
	}

	// Drop JSON null entries from `enum` lists.
	if (Array.isArray(obj.enum)) {
		obj.enum = obj.enum.filter((v: Json) => v !== null)
	}

	// Recurse into keyword schemas.
	if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
		for (const k of Object.keys(obj.properties)) {
			obj.properties[k] = normalizeNode(obj.properties[k])
		}
	}
	for (const key of ["items", "additionalProperties", "not", "contains", "propertyNames"]) {
		if (key in obj) {
			obj[key] = normalizeNode(obj[key])
		}
	}
	for (const key of ["oneOf", "anyOf", "allOf", "prefixItems"]) {
		if (Array.isArray(obj[key])) {
			obj[key] = obj[key].map(normalizeNode)
		}
	}
	for (const key of ["$defs", "definitions"]) {
		if (obj[key] && typeof obj[key] === "object" && !Array.isArray(obj[key])) {
			for (const k of Object.keys(obj[key])) {
				obj[key][k] = normalizeNode(obj[key][k])
			}
		}
	}

	// Post-process anyOf/oneOf: drop branches that normalized to an empty schema,
	// and collapse a single remaining branch into the parent (Moonshot rejects
	// both empty subschemas and degenerate one-element unions).
	for (const key of ["anyOf", "oneOf"]) {
		if (!Array.isArray(obj[key])) {
			continue
		}
		const filtered = (obj[key] as Json[]).filter(
			(entry) =>
				!(entry && typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry).length === 0),
		)
		if (filtered.length === 0) {
			delete obj[key]
		} else if (filtered.length === 1) {
			delete obj[key]
			const only = filtered[0]
			if (only && typeof only === "object" && !Array.isArray(only)) {
				for (const k of Object.keys(only)) {
					if (!(k in obj)) {
						obj[k] = only[k]
					}
				}
			}
		} else {
			obj[key] = filtered
		}
	}

	return obj
}
