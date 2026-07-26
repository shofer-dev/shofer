/**
 * Capability tag expressions: canonical form, hashing and matching.
 *
 * A `requires:` clause selects which runner an agent's stakes may execute on.
 * This module is the pure algebra behind it — no dispatch, no queues, no
 * Temporal — so the same code answers "does this runner satisfy this
 * requirement" in the interpreter, in a validator, and in whatever routes work.
 *
 * # Why DNF is the canonical form
 *
 * Temporal's routing primitive is the task queue, and an activity goes to
 * exactly ONE queue — there is no "post to either queue". So `a or b` cannot be
 * resolved at dispatch time by the sender. The resolution is inverted: the
 * expression is canonicalised, hashed, and becomes a queue name, and RUNNERS
 * evaluate every active expression against their own tag set and poll the queues
 * they satisfy.
 *
 * That only works if two specs writing the same requirement differently produce
 * the same queue. `a and (b or c)`, `(a and b) or (a and c)` and
 * `(b or c) and a` are the same requirement, and canonical DNF makes them the
 * same string.
 *
 * # No negation, deliberately
 *
 * There is no `not`. A declared tag from a semi-trusted workspace is an
 * ADVISORY scheduling hint, and matching on a tag's absence would quietly turn
 * it into a security signal — "runs only where `secure-enclave` is missing" is a
 * sentence nobody should be able to write against a set the runner controls. It
 * also goes stale the instant a runner gains a tag. Allow-only, like every other
 * selection algebra on the platform.
 */

import type { TagExpr } from "./slang-ast.js"

/** Disjunctive normal form: an OR of AND-terms, each a sorted tag list. */
export type TagDNF = string[][]

/**
 * Canonicalise an expression to sorted, deduplicated DNF.
 *
 * Distribution is exponential in the worst case, which is fine here: a
 * `requires:` clause is written by hand and names capabilities, so it is a
 * handful of atoms and not a generated formula.
 */
export function toDNF(expr: TagExpr): TagDNF {
	const raw = distribute(expr)

	// Normalise each term, then the term list. Both sorts matter: without the
	// inner one `a and b` and `b and a` hash differently; without the outer one
	// `a or b` and `b or a` do.
	const terms = raw
		.map((term) => [...new Set(term)].sort())
		.filter((term) => term.length > 0)
		.map((term) => term.join(" "))

	const unique = [...new Set(terms)].sort()
	return unique.map((t) => t.split(" "))
}

/** Recursively distribute AND over OR. */
function distribute(expr: TagExpr): string[][] {
	switch (expr.kind) {
		case "tag":
			return [[expr.name]]
		case "or":
			return expr.terms.flatMap(distribute)
		case "and": {
			// The cross-product of the sub-expressions' terms.
			let acc: string[][] = [[]]
			for (const sub of expr.terms) {
				const subTerms = distribute(sub)
				const next: string[][] = []
				for (const a of acc) {
					for (const b of subTerms) next.push([...a, ...b])
				}
				acc = next
			}
			return acc
		}
	}
}

/**
 * A stable, human-readable rendering of canonical DNF.
 *
 * Used as the hash input, and readable on its own so a queue name can be traced
 * back to a requirement without a lookup table.
 */
export function dnfToString(dnf: TagDNF): string {
	return dnf.map((term) => term.join("+")).join("|")
}

/**
 * A stable short hash of a canonical expression, for naming a queue.
 *
 * FNV-1a: tiny, dependency-free, and deterministic across processes — the last
 * point being the one that matters, since the producer naming a queue and the
 * consumer polling it are different services in different languages.
 *
 * It is not a cryptographic hash and does not need to be: a collision costs two
 * unrelated requirements sharing a queue, which the runner-side match then
 * filters out anyway, because a runner still checks that it satisfies the
 * expression before accepting work.
 */
export function tagExprHash(expr: TagExpr): string {
	const canonical = dnfToString(toDNF(expr))
	let h = 0x811c9dc5
	for (let i = 0; i < canonical.length; i++) {
		h ^= canonical.charCodeAt(i)
		h = Math.imul(h, 0x01000193) >>> 0
	}
	return h.toString(16).padStart(8, "0")
}

/**
 * Does a tag set satisfy an expression?
 *
 * True when ANY AND-term is fully covered — the definition of DNF satisfaction.
 */
export function satisfies(expr: TagExpr, tags: Iterable<string>): boolean {
	const owned = [...tags]
	return toDNF(expr).some((term) => term.every((atom) => owned.some((tag) => tagMatches(atom, tag))))
}

/**
 * Does one tag match one atom?
 *
 * `*` globs WITHIN a `:`-delimited segment and never across one, so `tool:*`
 * matches `tool:screenshot` but not `tool:a:b` — the same containment rule the
 * bus's address grammar uses, so one mental model covers both.
 */
export function tagMatches(atom: string, tag: string): boolean {
	const atomSegs = atom.split(":")
	const tagSegs = tag.split(":")
	if (atomSegs.length !== tagSegs.length) return false
	return atomSegs.every((a, i) => segmentMatches(a, tagSegs[i]!))
}

/** Glob one segment. `*` matches any run of characters within it. */
function segmentMatches(pattern: string, value: string): boolean {
	if (!pattern.includes("*")) return pattern === value
	// Escape everything but `*`, which becomes `.*`. Built from a closed
	// character set (the tag charset), so nothing can smuggle regex structure.
	const rx = "^" + pattern.split("*").map(escapeRegex).join(".*") + "$"
	return new RegExp(rx).test(value)
}

/** Escape regex metacharacters in a literal segment. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Every distinct atom an expression names, for validation and UI. */
export function tagAtoms(expr: TagExpr): string[] {
	return [...new Set(toDNF(expr).flat())].sort()
}
