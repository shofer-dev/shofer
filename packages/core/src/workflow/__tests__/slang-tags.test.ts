/**
 * Capability tag algebra tests.
 *
 * The property everything else rests on is CANONICALITY: two specs writing the
 * same requirement differently must produce the same hash, because that hash
 * becomes a task-queue name. If it does not hold, two identical requirements
 * land on different queues and one of them has no runner polling it — a
 * pipeline that hangs with no error, which is exactly the failure mode this
 * design is trying to make impossible.
 */

import { describe, it, expect } from "vitest"

import { parse } from "../slang-parser-upstream.js"
import { toDNF, dnfToString, tagExprHash, satisfies, tagMatches, tagAtoms } from "../slang-tags.js"
import type { AgentDecl, TagExpr } from "../slang-ast.js"

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
	const req = agent.meta.requires
	expect(req).toBeDefined()
	return req!
}

describe("parsing", () => {
	it("reads a single tag", () => {
		expect(toDNF(requiresOf("browser"))).toEqual([["browser"]])
	})

	it("reads a conjunction", () => {
		expect(toDNF(requiresOf("browser and gpu"))).toEqual([["browser", "gpu"]])
	})

	it("reads a disjunction", () => {
		expect(toDNF(requiresOf("gpu or highmem"))).toEqual([["gpu"], ["highmem"]])
	})

	it("treats a bracketed list as sugar for a conjunction", () => {
		expect(toDNF(requiresOf("[browser, gpu]"))).toEqual(toDNF(requiresOf("browser and gpu")))
	})

	it("reads namespaced and globbed atoms", () => {
		expect(tagAtoms(requiresOf("tool:screenshot"))).toEqual(["tool:screenshot"])
		expect(tagAtoms(requiresOf("os:win*"))).toEqual(["os:win*"])
		expect(tagAtoms(requiresOf("tool:*"))).toEqual(["tool:*"])
	})

	it("REFUSES negation, with the reason", () => {
		// Allow-only is the platform-wide rule: matching on a missing tag turns an
		// advisory capability claim into a security signal.
		expect(() => requiresOf("browser and not gpu")).toThrow(/negation|allow-only/i)
	})
})

describe("canonical form", () => {
	it("is order-independent within a conjunction", () => {
		expect(tagExprHash(requiresOf("browser and gpu"))).toEqual(tagExprHash(requiresOf("gpu and browser")))
	})

	it("is order-independent within a disjunction", () => {
		expect(tagExprHash(requiresOf("gpu or highmem"))).toEqual(tagExprHash(requiresOf("highmem or gpu")))
	})

	it("distributes AND over OR, so factored and expanded forms agree", () => {
		// The case that makes canonicalisation necessary rather than cosmetic:
		// these are the same requirement and MUST reach the same queue.
		const factored = requiresOf("browser and (gpu or highmem)")
		const expanded = requiresOf("(browser and gpu) or (browser and highmem)")
		expect(dnfToString(toDNF(factored))).toEqual(dnfToString(toDNF(expanded)))
		expect(tagExprHash(factored)).toEqual(tagExprHash(expanded))
	})

	it("deduplicates a repeated atom", () => {
		expect(toDNF(requiresOf("gpu and gpu"))).toEqual([["gpu"]])
	})

	it("gives different requirements different hashes", () => {
		expect(tagExprHash(requiresOf("browser"))).not.toEqual(tagExprHash(requiresOf("gpu")))
		expect(tagExprHash(requiresOf("a and b"))).not.toEqual(tagExprHash(requiresOf("a or b")))
	})
})

describe("satisfaction", () => {
	it("requires every atom of some term", () => {
		const expr = requiresOf("browser and gpu")
		expect(satisfies(expr, ["browser", "gpu", "extra"])).toBe(true)
		expect(satisfies(expr, ["browser"])).toBe(false)
	})

	it("accepts a runner matching either branch of a disjunction", () => {
		const expr = requiresOf("gpu or highmem")
		expect(satisfies(expr, ["highmem"])).toBe(true)
		expect(satisfies(expr, ["gpu"])).toBe(true)
		expect(satisfies(expr, ["cpu-only"])).toBe(false)
	})

	it("is unsatisfied by an empty tag set", () => {
		expect(satisfies(requiresOf("browser"), [])).toBe(false)
	})
})

describe("glob matching", () => {
	it("globs within a segment", () => {
		expect(tagMatches("tool:*", "tool:screenshot")).toBe(true)
		expect(tagMatches("os:win*", "os:windows")).toBe(true)
		expect(tagMatches("os:win*", "os:linux")).toBe(false)
	})

	it("never crosses a segment boundary", () => {
		// The same containment rule the bus address grammar uses, so one mental
		// model covers both. `tool:*` is one segment and must not swallow two.
		expect(tagMatches("tool:*", "tool:a:b")).toBe(false)
		expect(tagMatches("*", "tool:screenshot")).toBe(false)
	})

	it("does not let an atom smuggle regex structure", () => {
		// Atoms come from a spec, so a metacharacter must be literal rather than
		// compiled — otherwise a tag could match far more than it names.
		expect(tagMatches("a.c", "abc")).toBe(false)
		expect(tagMatches("a.c", "a.c")).toBe(true)
	})
})
