/**
 * Capability tag expressions: canonical form, hashing and matching.
 *
 * A `requires:` clause selects which worker an agent's stakes may execute on.
 * This module is the pure algebra behind it — no dispatch, no queues, no
 * Temporal — so the same code answers "does this worker satisfy this
 * requirement" in the interpreter, in a validator, and in whatever routes work.
 *
 * # This file is a MIRROR, not an implementation
 *
 * `shared/tagexpr` (Go) is the canonical implementation, and this is its
 * TypeScript half. They are not two libraries that happen to agree — they are
 * one contract with two runtimes, because the producer naming a queue and the
 * consumer polling it are different services in different languages. The
 * canonical serialization, the absorption rule, the hash and the glob semantics
 * are all fixed there; nothing in this file may be "improved" on its own.
 *
 * The agreement is enforced, not asserted: both sides run the shared corpus at
 * `shared/tagexpr/testdata/vectors.json`. Change the algebra and the corpus
 * fails on whichever side you forgot.
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
 * sentence nobody should be able to write against a set the worker controls. It
 * also goes stale the instant a worker gains a tag. Allow-only, like every other
 * selection algebra on the platform.
 */

import type { TagExpr } from "./slang-ast.js"
import { sha256Hex } from "./sha256.js"

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
	// 1. Sort and dedup atoms within each term.
	let terms = distribute(expr).map((t) => [...new Set(t)].sort())

	// 2. Dedup identical terms.
	const seen = new Set<string>()
	terms = terms.filter((t) => {
		const key = t.join("\u0000")
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})

	// 3. Absorption: drop any term T that some other term S strictly covers
	//    (S ⊆ T). S is satisfiable whenever T is, so T's extra atoms are
	//    redundant — `a or (a and b)` is just `a`. Without this step the same
	//    requirement written two ways survives as two terms and hashes to two
	//    queue names, which is the whole failure this module exists to prevent.
	const kept = terms.filter((t, i) => !terms.some((s, j) => i !== j && s.length < t.length && subset(s, t)))

	// 4. Sort terms by their serialized form.
	return kept.sort((a, b) => {
		const [x, y] = [a.join(" and "), b.join(" and ")]
		return x < y ? -1 : x > y ? 1 : 0
	})
}

/** Does every atom of the sorted term `s` appear in the sorted term `t`? */
function subset(s: string[], t: string[]): boolean {
	let i = 0
	for (const a of t) if (i < s.length && s[i] === a) i++
	return i === s.length
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
 * The canonical serialization: terms joined by `" or "`, atoms by `" and "`.
 *
 * No parentheses are ever needed because the form is DNF and `and` binds tighter
 * than `or`. This is the cross-language contract — `shared/tagexpr`'s
 * `Expr.String()` — so its shape is fixed, not a formatting preference.
 */
export function dnfToString(dnf: TagDNF): string {
	return dnf.map((term) => term.join(" and ")).join(" or ")
}

/**
 * A stable content hash of the canonical serialization: the first 16 hex
 * characters (64 bits) of its SHA-256.
 *
 * It names Temporal task queues and dedups registry entries, so it MUST stay
 * stable across releases and identical to `shared/tagexpr`'s `Expr.Hash()` — a
 * change silently re-partitions live work, and a divergence means the queue a
 * worker polls is not the queue the interpreter dispatches to.
 *
 * The strength is irrelevant to security here; it names a queue. A collision
 * would cost two unrelated requirements sharing a queue, which the worker-side
 * match filters anyway, because a worker re-checks that it satisfies the
 * expression before accepting work.
 */
export function tagExprHash(expr: TagExpr): string {
	return sha256Hex(dnfToString(toDNF(expr))).slice(0, 16)
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
 * Mirrors `shared/tagexpr`'s `SetBinding.MatchAtom`. Segment counts must be
 * equal, and each atom segment glob-matches the corresponding element segment:
 * `?` is exactly one character and `*` any run WITHIN a `:`-delimited segment,
 * never across one. So `tool:*` matches `tool:screenshot` but not `tool:a:b`.
 * There is deliberately no `**` — whole-segment-spanning wildcards belong to the
 * segmented address domain (`shared/tagaddr`), and admitting one here would blur
 * two vocabularies that are kept distinct on purpose.
 */
export function tagMatches(atom: string, tag: string): boolean {
	const atomSegs = atom.split(":")
	const tagSegs = tag.split(":")
	if (atomSegs.length !== tagSegs.length) return false
	return atomSegs.every((a, i) => segmentMatches(a, tagSegs[i]!))
}

/**
 * Glob one segment: `?` consumes exactly one character, `*` any run including
 * empty. Linear-time backtracking, matching the Go implementation's shape rather
 * than compiling a regex — an atom is untrusted spec text, and translating it to
 * a pattern language is how a metacharacter escapes its literal meaning.
 */
function segmentMatches(pattern: string, s: string): boolean {
	let px = 0
	let sx = 0
	let starPx = -1
	let starSx = -1
	while (sx < s.length) {
		if (px < pattern.length && (pattern[px] === "?" || pattern[px] === s[sx])) {
			px++
			sx++
		} else if (px < pattern.length && pattern[px] === "*") {
			starPx = px
			starSx = sx
			px++
		} else if (starPx >= 0) {
			px = starPx + 1
			starSx++
			sx = starSx
		} else {
			return false
		}
	}
	while (px < pattern.length && pattern[px] === "*") px++
	return px === pattern.length
}

/**
 * The atom grammar, and the security boundary: a segment is `[A-Za-z0-9_-]` plus
 * the globs `?` and `*`. Validation runs before an atom is ever matched, so no
 * out-of-charset character reaches the matcher. Mirrors
 * `SetBinding.ValidateAtom`.
 */
export function validateAtom(atom: string): string | undefined {
	if (atom === "") return "empty atom"
	for (const seg of atom.split(":")) {
		if (seg === "") return "empty segment (consecutive ':' or a leading/trailing ':')"
		for (let i = 0; i < seg.length; i++) {
			const c = seg[i]!
			if (/[A-Za-z0-9_?-]/.test(c)) continue
			if (c === "*") {
				if (seg[i + 1] === "*") {
					return `segment "${seg}" contains '**'; '**' is not a set-binding token (globs are '?' and '*' within a segment)`
				}
				continue
			}
			return `segment "${seg}" contains "${c}"; atoms must match [A-Za-z0-9_-?*]`
		}
	}
	return undefined
}

/** Every distinct atom an expression names, for validation and UI. */
export function tagAtoms(expr: TagExpr): string[] {
	return [...new Set(toDNF(expr).flat())].sort()
}
