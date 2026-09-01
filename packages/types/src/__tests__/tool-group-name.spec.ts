import { toolGroupNameSchema, toolGroups, TOOL_GROUPS, getToolGroupConfig } from "../tool.js"
import { groupEntrySchema } from "../mode.js"
import { getToolsForMode } from "../modes.js"

/**
 * The category vocabulary is OPEN: `toolGroupNameSchema` is the whole gate, and
 * everything downstream must tolerate a name it has never seen.
 */
describe("toolGroupNameSchema", () => {
	it("accepts a builtin name and a dynamic slug alike", () => {
		for (const name of ["read", "browser", "salesforce", "acme-crm", "s3", "a"]) {
			expect(toolGroupNameSchema.safeParse(name).success, name).toBe(true)
		}
	})

	it("accepts every builtin group name (so 'builtin or slug' collapses to 'slug')", () => {
		for (const builtin of toolGroups) {
			expect(toolGroupNameSchema.safeParse(builtin).success, builtin).toBe(true)
		}
	})

	it("rejects anything that is not a lowercase hyphenated slug", () => {
		for (const bad of [
			"Bad_Name",
			"a:b",
			"*",
			"",
			"Browser",
			"trailing-",
			"-leading",
			"two--hyphens",
			"has space",
		]) {
			expect(toolGroupNameSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
		}
	})

	it("rejects a name longer than 64 characters", () => {
		expect(toolGroupNameSchema.safeParse("a".repeat(64)).success).toBe(true)
		expect(toolGroupNameSchema.safeParse("a".repeat(65)).success).toBe(false)
	})

	// The wildcard is the `alwaysAllowGroups` escape hatch; it must never be
	// mintable as a real category, or a user could shadow it.
	it("refuses the reserved wildcard", () => {
		expect(toolGroupNameSchema.safeParse("*").success).toBe(false)
	})
})

describe("builtin vocabulary", () => {
	it("has exactly the 8 builtins, browser no longer among them", () => {
		expect([...toolGroups]).toEqual([
			"read",
			"write",
			"execute",
			"mcp",
			"mode",
			"subtasks",
			"questions",
			"uncategorized",
		])
		expect(Object.keys(TOOL_GROUPS).sort()).toEqual([...toolGroups].sort())
		expect("browser" in TOOL_GROUPS).toBe(false)
	})

	it("answers undefined for a dynamic category rather than throwing", () => {
		expect(getToolGroupConfig("read")?.tools).toContain("read_file")
		expect(getToolGroupConfig("browser")).toBeUndefined()
		expect(getToolGroupConfig("salesforce")).toBeUndefined()
	})
})

describe("mode group entries", () => {
	it("validates a dynamic category in every entry form", () => {
		expect(groupEntrySchema.safeParse("salesforce").success).toBe(true)
		expect(groupEntrySchema.safeParse(["browser", { fileRegex: "\\.html$" }]).success).toBe(true)
		expect(groupEntrySchema.safeParse({ salesforce: { denied: ["x"] } }).success).toBe(true)
	})

	it("still refuses a non-slug in every entry form", () => {
		expect(groupEntrySchema.safeParse("Bad_Name").success).toBe(false)
		expect(groupEntrySchema.safeParse(["Bad_Name", {}]).success).toBe(false)
		expect(groupEntrySchema.safeParse({ "Bad Name": {} }).success).toBe(false)
	})

	// Before the vocabulary opened, this threw a TypeError — it was protected only
	// by the schema wall that now admits the name.
	it("treats a group with no builtin entry as an empty native tool set", () => {
		const withDynamic = getToolsForMode(["read", "salesforce"])
		const readOnly = getToolsForMode(["read"])
		expect(withDynamic.sort()).toEqual(readOnly.sort())
	})
})
