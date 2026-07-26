/**
 * Output contracts: the two-layer check a `stake` result must pass.
 *
 * A `stake` may declare what its answer must look like:
 *
 *     stake review(diff: d) -> @out
 *       output: { score: "number", verdict: "string" } where score > 7
 *
 * Two layers, and the split is the point:
 *
 *  1. **Structural** — the result parses as a JSON object and every declared
 *     field is present with the declared type. This is what a JSON schema can
 *     express, and it is what a provider's structured-output mode enforces.
 *  2. **Semantic** — the optional `where` predicate, evaluated with the result's
 *     fields in scope as bare idents. This is what a schema CANNOT express: "the
 *     shape is right but the answer is wrong". `where score > 7` can assume
 *     `score` exists and is a number precisely because layer 1 already
 *     established it.
 *
 * # Why both are pure functions of a recorded result
 *
 * Under the Temporal backend these run inside the workflow, over the activity's
 * recorded output, so they must replay deterministically: no clock, no RNG, no
 * IO. `evalExpr` is already that, and nothing here adds any.
 *
 * # Why a violation is not a Temporal retry
 *
 * A failed contract is retried by RE-PROMPTING the same agent session with the
 * specific violation as feedback — not by re-running the activity. Temporal's
 * RetryPolicy re-runs with the original inputs and no session, so it cannot
 * carry corrective feedback and cannot resume the conversation, which is the
 * entire value of the mechanism. The two retry concepts stay separate.
 */

import type { Expr, OutputSchema, StakeOp } from "./slang-ast.js"
import type { AgentState, FlowState } from "./slang-types.js"
import { evalExpr, toBool } from "./slang-interpreter.js"

/** The outcome of checking one result against a contract. */
export type ContractCheck =
	| { ok: true; value: unknown }
	| { ok: false; error: string; layer: "structural" | "semantic" }

/** Type predicates for the scalar vocabulary a contract may declare. */
const TYPE_OK: Record<string, (v: unknown) => boolean> = {
	string: (v) => typeof v === "string",
	number: (v) => typeof v === "number",
	boolean: (v) => typeof v === "boolean",
}

/**
 * Strip a Markdown code fence, which models add unbidden.
 *
 * Tolerated rather than rejected: a fenced object is the model answering
 * correctly and formatting habitually, and failing it would burn a retry on
 * punctuation.
 */
export function stripFence(raw: string): string {
	const trimmed = raw.trim()
	if (!trimmed.startsWith("```")) return trimmed
	return trimmed
		.replace(/^```[a-zA-Z]*\s*/, "")
		.replace(/```\s*$/, "")
		.trim()
}

/** Layer 1: parse and structurally validate a raw result. */
export function validateContract(raw: string, schema: OutputSchema | undefined): ContractCheck {
	if (!schema) return { ok: true, value: undefined }

	let parsed: unknown
	try {
		parsed = JSON.parse(stripFence(raw))
	} catch (e) {
		return { ok: false, layer: "structural", error: `result is not valid JSON (${(e as Error).message})` }
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, layer: "structural", error: "result must be a JSON object" }
	}

	const obj = parsed as Record<string, unknown>
	for (const f of schema.fields) {
		if (!(f.name in obj)) {
			return { ok: false, layer: "structural", error: `missing required field "${f.name}"` }
		}
		const check = TYPE_OK[f.fieldType]
		if (check && !check(obj[f.name])) {
			return { ok: false, layer: "structural", error: `field "${f.name}" must be ${f.fieldType}` }
		}
	}
	return { ok: true, value: obj }
}

/**
 * Layer 2: evaluate the `where` predicate with the result's fields in scope.
 *
 * The result's fields SHADOW the agent's bindings for the duration of this
 * check, which is what makes `where score > 7` read naturally. It is a copy —
 * the agent's own bindings are never mutated by a validation.
 */
export function checkSemanticContract(
	where: Expr | undefined,
	value: unknown,
	state: AgentState,
	flowState: FlowState,
): ContractCheck {
	if (!where) return { ok: true, value }
	if (typeof value !== "object" || value === null) {
		return { ok: true, value }
	}

	const scoped: AgentState = {
		...state,
		bindings: new Map<string, unknown>([...state.bindings, ...Object.entries(value as Record<string, unknown>)]),
	}
	if (!toBool(evalExpr(where, scoped, flowState))) {
		return {
			ok: false,
			layer: "semantic",
			error: "the answer is well-formed but violates the contract's `where` constraint",
		}
	}
	return { ok: true, value }
}

/** Run both layers over one raw result. */
export function checkContract(
	op: Pick<StakeOp, "output" | "where">,
	raw: string,
	state: AgentState,
	flowState: FlowState,
): ContractCheck {
	const structural = validateContract(raw, op.output)
	if (!structural.ok) return structural
	return checkSemanticContract(op.where, structural.value, state, flowState)
}

/**
 * Render the corrective feedback for a failed check.
 *
 * The message names WHICH layer failed, because the two need different
 * corrections: a structural failure means "answer in this shape", a semantic one
 * means "the shape was right, change the values".
 */
export function contractFeedback(check: Extract<ContractCheck, { ok: false }>): string {
	if (check.layer === "semantic") {
		return (
			"Your answer was well-formed but violated the contract's semantic constraint " +
			"(the `where` clause). Revise the values so the constraint holds, and reply with " +
			"ONLY the JSON object."
		)
	}
	return `Your answer did not satisfy the output contract: ${check.error}. Reply with ONLY the JSON object.`
}

// contractToJsonSchema is NOT defined here: `slang-ast.ts` already owns it, with
// the same semantics. A second copy would be a second answer to "what schema
// does this contract compile to", and the two would drift the first time the
// field vocabulary grew.
