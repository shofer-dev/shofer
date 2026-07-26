/**
 * The cross-language agreement test.
 *
 * `shared/tagexpr` (Go) and `slang-tags.ts` (TypeScript) are one contract with
 * two runtimes: Go names a capability queue in the registrar, TypeScript
 * dispatches to it from the interpreter workflow, and a runner matches against
 * it. If the two ever disagree — on absorption, on the canonical string, on the
 * hash, on a glob — a stake goes to a queue nothing polls and the pipeline hangs
 * with no error at all.
 *
 * So neither side owns the corpus: both read
 * `shared/tagexpr/testdata/vectors.json`, and changing the algebra on one side
 * fails on the other.
 *
 * The vectors are written in the Go library's own surface syntax (`a and b`),
 * which is also Slang's `requires:` syntax — so each case is fed through the
 * Slang parser and compared against the Go-produced expectations.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

import { parse } from "../slang-parser-upstream.js"
import { toDNF, dnfToString, tagExprHash, satisfies, validateAtom } from "../slang-tags.js"
import type { AgentDecl, TagExpr } from "../slang-ast.js"

/** One entry of the shared corpus. Optional fields are absent, not zero. */
interface VectorCase {
	name: string
	binding?: string
	expr: string
	parseError?: boolean
	canonical?: string
	hash?: string
	subject?: string[]
	verdict?: boolean
}

const corpusPath = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../../../../shared/tagexpr/testdata/vectors.json",
)
const cases: VectorCase[] = JSON.parse(readFileSync(corpusPath, "utf8")).cases

/** Parse a `requires:` clause out of a one-agent spec. */
function requiresOf(clause: string): TagExpr {
	const source = `flow "f" {
  agent A {
    requires: ${clause}
    role: "r"
    stake go(x: "1") -> @out
    commit
  }
  converge when: @A.committed
}`
	const flow = parse(source).flows[0]!
	const agent = flow.body.find((n) => n.type === "AgentDecl") as AgentDecl
	return agent.meta.requires!
}

describe("cross-language vector corpus", () => {
	it("is loaded and non-empty", () => {
		expect(cases.length).toBeGreaterThan(0)
	})

	for (const c of cases) {
		it(`${c.name}${c.binding ? ` [${c.binding}]` : ""}`, () => {
			if (c.parseError) {
				// Rejected by the parser OR by atom validation — both are "this
				// expression never reaches the matcher", which is the property.
				let rejected = false
				try {
					const expr = requiresOf(c.expr)
					rejected = toDNF(expr)
						.flat()
						.some((atom) => validateAtom(atom) !== undefined)
				} catch {
					rejected = true
				}
				expect(rejected, `${c.expr} must be rejected`).toBe(true)
				return
			}

			const expr = requiresOf(c.expr)
			const dnf = toDNF(expr)

			if (c.canonical !== undefined) expect(dnfToString(dnf)).toBe(c.canonical)
			if (c.hash !== undefined) expect(tagExprHash(expr)).toBe(c.hash)
			if (c.subject !== undefined && c.verdict !== undefined) {
				expect(satisfies(expr, c.subject)).toBe(c.verdict)
			}
		})
	}
})
