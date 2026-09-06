import { findLongestPrefixMatch, isAutoApprovedSingleCommand, isAutoDeniedSingleCommand } from "../commands.js"

/**
 * The LONGEST-PREFIX-MATCH rule that resolves an allowlist against a denylist
 * for a single command.
 *
 * The rule is asymmetric on purpose, and the asymmetry is the safety property:
 * an allowlist entry must be strictly LONGER than the matching denylist entry
 * to approve, while a denylist entry of EQUAL length is enough to deny. So a
 * tie goes to refusal — `git push` in both lists denies — and a broad `*`
 * cannot out-rank a specific denial.
 */

describe("findLongestPrefixMatch", () => {
	it("returns the longest of several matching prefixes", () => {
		expect(findLongestPrefixMatch("git push origin", ["git", "git push"])).toBe("git push")
	})

	it("prefers a specific match over the wildcard, which counts as length 1", () => {
		expect(findLongestPrefixMatch("npm install", ["*", "npm"])).toBe("npm")
	})

	it("still matches through the wildcard when nothing specific does", () => {
		expect(findLongestPrefixMatch("anything at all", ["*"])).toBe("*")
	})

	it("matches case-insensitively and ignores surrounding whitespace", () => {
		expect(findLongestPrefixMatch("  GIT status ", ["git"])).toBe("git")
	})

	it("returns null for no match, an empty command, or no prefixes", () => {
		expect(findLongestPrefixMatch("unknown", ["git", "npm"])).toBeNull()
		expect(findLongestPrefixMatch("", ["git"])).toBeNull()
		expect(findLongestPrefixMatch("git", [])).toBeNull()
	})
})

describe("isAutoApprovedSingleCommand", () => {
	it("approves the empty command, which has nothing to run", () => {
		expect(isAutoApprovedSingleCommand("", ["git"])).toBe(true)
	})

	it("approves nothing when no allowlist is configured", () => {
		expect(isAutoApprovedSingleCommand("git status", [])).toBe(false)
		expect(isAutoApprovedSingleCommand("git status", undefined as never)).toBe(false)
	})

	describe("with NO denylist supplied", () => {
		it("approves on a plain prefix match, case-insensitively", () => {
			expect(isAutoApprovedSingleCommand("GIT status", ["git"])).toBe(true)
			expect(isAutoApprovedSingleCommand("npm install", ["git"])).toBe(false)
		})

		it("approves anything under the wildcard", () => {
			expect(isAutoApprovedSingleCommand("rm -rf /", ["*"])).toBe(true)
		})
	})

	describe("with a denylist supplied", () => {
		it("approves when only the allowlist matches", () => {
			expect(isAutoApprovedSingleCommand("git status", ["git"], ["rm"])).toBe(true)
		})

		it("refuses when only the denylist matches", () => {
			expect(isAutoApprovedSingleCommand("rm -rf /", ["git"], ["rm"])).toBe(false)
		})

		it("lets a LONGER allowlist entry beat a shorter denial", () => {
			expect(isAutoApprovedSingleCommand("git push origin", ["git push"], ["git"])).toBe(true)
		})

		it("refuses a TIE, so an equal-length denial wins", () => {
			expect(isAutoApprovedSingleCommand("git push origin", ["git push"], ["git push"])).toBe(false)
		})

		it("refuses when the denial is longer than the allowance", () => {
			expect(isAutoApprovedSingleCommand("git push origin", ["git"], ["git push"])).toBe(false)
		})

		it("approves under the wildcard only while nothing is denied", () => {
			expect(isAutoApprovedSingleCommand("rm -rf /", ["*"], ["curl"])).toBe(true)
			expect(isAutoApprovedSingleCommand("rm -rf /", ["*"], ["rm"])).toBe(false)
		})

		it("refuses a command neither list mentions", () => {
			expect(isAutoApprovedSingleCommand("mystery", ["git"], ["rm"])).toBe(false)
		})
	})
})

describe("isAutoDeniedSingleCommand", () => {
	it("denies nothing for an empty command or an empty denylist", () => {
		expect(isAutoDeniedSingleCommand("", ["git"], ["rm"])).toBe(false)
		expect(isAutoDeniedSingleCommand("rm -rf /", ["git"], [])).toBe(false)
		expect(isAutoDeniedSingleCommand("rm -rf /", ["git"], undefined)).toBe(false)
	})

	it("denies when only the denylist matches", () => {
		expect(isAutoDeniedSingleCommand("rm -rf /", ["git"], ["rm"])).toBe(true)
	})

	it("denies on a TIE — the mirror of the approval rule", () => {
		expect(isAutoDeniedSingleCommand("git push origin", ["git push"], ["git push"])).toBe(true)
	})

	it("does not deny when the allowance is strictly longer", () => {
		expect(isAutoDeniedSingleCommand("git push origin", ["git push"], ["git"])).toBe(false)
	})

	it("denies when the denial is longer than the allowance", () => {
		expect(isAutoDeniedSingleCommand("git push origin", ["git"], ["git push"])).toBe(true)
	})

	it("tolerates an absent allowlist", () => {
		expect(isAutoDeniedSingleCommand("rm -rf /", undefined as never, ["rm"])).toBe(true)
	})
})
