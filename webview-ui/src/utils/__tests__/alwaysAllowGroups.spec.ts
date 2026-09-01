import { diffAlwaysAllowGroups, isEmptyAlwaysAllowGroupsPatch, asAlwaysAllowGroupsSetting } from "../alwaysAllowGroups"

describe("diffAlwaysAllowGroups", () => {
	it("returns an empty patch when nothing moved", () => {
		const patch = diffAlwaysAllowGroups({ browser: true, salesforce: false }, { browser: true, salesforce: false })

		expect(patch).toEqual({})
		expect(isEmptyAlwaysAllowGroupsPatch(patch)).toBe(true)
	})

	it("sends ONLY the entries whose value changed", () => {
		// The untouched `browser` entry may have come from an org or project scope;
		// echoing it back would copy it into the write scope and shadow that scope's
		// later changes forever.
		const patch = diffAlwaysAllowGroups({ browser: true, salesforce: false }, { browser: true, salesforce: true })

		expect(patch).toEqual({ salesforce: true })
	})

	it("treats a newly added entry as a set", () => {
		expect(diffAlwaysAllowGroups({ browser: true }, { browser: true, salesforce: false })).toEqual({
			salesforce: false,
		})
	})

	it("sends null for an entry that disappeared", () => {
		expect(diffAlwaysAllowGroups({ browser: true, salesforce: true }, { browser: true })).toEqual({
			salesforce: null,
		})
	})

	it("handles either side being undefined", () => {
		expect(diffAlwaysAllowGroups(undefined, { salesforce: true })).toEqual({ salesforce: true })
		expect(diffAlwaysAllowGroups({ salesforce: true }, undefined)).toEqual({ salesforce: null })
		expect(diffAlwaysAllowGroups(undefined, undefined)).toEqual({})
	})

	it("carries the wildcard like any other entry", () => {
		expect(diffAlwaysAllowGroups({}, { "*": true })).toEqual({ "*": true })
	})

	it("passes the patch through unchanged when cast for the payload", () => {
		const patch = { salesforce: true, stale: null }

		expect(asAlwaysAllowGroupsSetting(patch)).toBe(patch)
	})
})
