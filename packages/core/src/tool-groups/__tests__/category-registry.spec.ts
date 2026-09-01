import { toolGroups } from "@shofer/types"

import { ToolGroupRegistry, getDynamicToolGroups, registerToolGroup, toolGroupRegistry } from "../category-registry.js"

describe("ToolGroupRegistry", () => {
	let registry: ToolGroupRegistry

	beforeEach(() => {
		registry = new ToolGroupRegistry()
	})

	describe("register", () => {
		it("mints a category from a valid slug and reports that it is new", () => {
			expect(registry.register("salesforce")).toBe(true)
			expect(registry.getDynamicGroups()).toEqual(["salesforce"])
		})

		it("is a no-op the second time the same name arrives", () => {
			expect(registry.register("salesforce")).toBe(true)
			expect(registry.register("salesforce")).toBe(false)
			expect(registry.getDynamicGroups()).toEqual(["salesforce"])
		})

		// A builtin's toggle is a flat settings key; a registry entry for it would be
		// a second source of truth for the same category.
		it("refuses every builtin", () => {
			for (const builtin of toolGroups) {
				expect(registry.register(builtin), builtin).toBe(false)
			}
			expect(registry.getDynamicGroups()).toEqual([])
		})

		it("refuses the reserved wildcard", () => {
			expect(registry.register("*")).toBe(false)
			expect(registry.getDynamicGroups()).toEqual([])
		})

		it("refuses a name that is not a slug", () => {
			for (const bad of ["Bad_Name", "a:b", "", "Browser", "has space", "a".repeat(65)]) {
				expect(registry.register(bad), JSON.stringify(bad)).toBe(false)
			}
			expect(registry.getDynamicGroups()).toEqual([])
		})

		it("returns a sorted, stable snapshot", () => {
			registry.register("zeta")
			registry.register("alpha")
			registry.register("mid-name")
			expect(registry.getDynamicGroups()).toEqual(["alpha", "mid-name", "zeta"])
		})
	})

	describe("registerToolMapping", () => {
		it("resolves a tool to the group it declared, and registers that group", () => {
			registry.registerToolMapping("close_deal", "salesforce")
			expect(registry.groupForTool("close_deal")).toBe("salesforce")
			expect(registry.getDynamicGroups()).toEqual(["salesforce"])
		})

		// A tool declaring a BUILTIN still needs the mapping — that is what lets the
		// approval path read the declaration instead of guessing from the name.
		it("records a builtin declaration without minting a category", () => {
			registry.registerToolMapping("ide_search", "read")
			expect(registry.groupForTool("ide_search")).toBe("read")
			expect(registry.getDynamicGroups()).toEqual([])
		})

		it("records nothing for a malformed group name", () => {
			registry.registerToolMapping("weird", "Not A Group")
			expect(registry.groupForTool("weird")).toBeUndefined()
			expect(registry.getDynamicGroups()).toEqual([])
		})

		it("answers undefined for a tool nobody declared", () => {
			expect(registry.groupForTool("never_seen")).toBeUndefined()
		})

		it("lets a later declaration replace an earlier one", () => {
			registry.registerToolMapping("close_deal", "salesforce")
			registry.registerToolMapping("close_deal", "write")
			expect(registry.groupForTool("close_deal")).toBe("write")
		})
	})

	describe("onDidChange", () => {
		it("fires when a category is added and not when a call is a no-op", () => {
			const listener = vi.fn()
			registry.onDidChange(listener)

			registry.register("salesforce")
			expect(listener).toHaveBeenCalledTimes(1)

			registry.register("salesforce")
			registry.register("read")
			registry.register("*")
			registry.register("Bad_Name")
			expect(listener).toHaveBeenCalledTimes(1)

			registry.registerToolMapping("close_deal", "acme-crm")
			expect(listener).toHaveBeenCalledTimes(2)
		})

		it("stops firing after dispose", () => {
			const listener = vi.fn()
			const dispose = registry.onDidChange(listener)

			registry.register("one")
			dispose()
			registry.register("two")

			expect(listener).toHaveBeenCalledTimes(1)
		})

		// The category is already recorded by the time listeners run; losing the rest
		// of the fan-out would leave the UI and the registry disagreeing.
		it("keeps notifying the remaining listeners when one throws", () => {
			const second = vi.fn()
			registry.onDidChange(() => {
				throw new Error("boom")
			})
			registry.onDidChange(second)

			expect(registry.register("salesforce")).toBe(true)
			expect(second).toHaveBeenCalledTimes(1)
		})
	})
})

describe("the singleton and its delegates", () => {
	beforeEach(() => {
		toolGroupRegistry.reset()
	})

	it("delegate functions act on the shared registry", () => {
		expect(registerToolGroup("salesforce")).toBe(true)
		expect(getDynamicToolGroups()).toEqual(["salesforce"])
		expect(toolGroupRegistry.getDynamicGroups()).toEqual(["salesforce"])
	})
})
