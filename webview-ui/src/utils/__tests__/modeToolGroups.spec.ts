import { getGroupsListedByAnyMode, getModeAllowedGroups, toolGroupNameOfEntry } from "../modeToolGroups"

describe("toolGroupNameOfEntry", () => {
	it("reads the name off each of the three entry shapes", () => {
		expect(toolGroupNameOfEntry("read")).toBe("read")
		expect(toolGroupNameOfEntry(["write", { fileRegex: "\\.md$" }])).toBe("write")
		expect(toolGroupNameOfEntry({ read: { allowed: ["read_file"] } })).toBe("read")
	})
})

describe("getModeAllowedGroups", () => {
	const modes = [
		{ slug: "code", tools: ["read", "write", "salesforce"] },
		{ slug: "ask", tools: ["read"] },
		{ slug: "loose" },
	]

	it("returns the names the mode lists, dynamic categories included", () => {
		expect(getModeAllowedGroups("code", modes)).toEqual(new Set(["read", "write", "salesforce"]))
	})

	it("excludes a dynamic category the mode does not list", () => {
		expect(getModeAllowedGroups("ask", modes)?.has("salesforce")).toBe(false)
	})

	it("returns undefined when there is nothing to filter against", () => {
		expect(getModeAllowedGroups("loose", modes)).toBeUndefined()
		expect(getModeAllowedGroups("unknown-slug", modes)).toBeUndefined()
		expect(getModeAllowedGroups(undefined, modes)).toBeUndefined()
		expect(getModeAllowedGroups("code", undefined)).toBeUndefined()
	})
})

describe("getGroupsListedByAnyMode", () => {
	it("unions the names across every mode, whatever entry shape they use", () => {
		expect(
			getGroupsListedByAnyMode([
				{ slug: "code", tools: ["read", ["write", {}]] },
				{ slug: "ops", tools: [{ salesforce: {} }] },
				{ slug: "bare" },
			]),
		).toEqual(new Set(["read", "write", "salesforce"]))
	})

	it("is empty when no modes are known", () => {
		expect(getGroupsListedByAnyMode(undefined)).toEqual(new Set())
	})
})
