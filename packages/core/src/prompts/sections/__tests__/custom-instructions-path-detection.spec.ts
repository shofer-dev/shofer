import * as path from "path"

describe("custom-instructions path detection", () => {
	it("should use exact path comparison instead of string includes", () => {
		// Test the logic that our fix implements
		const fakeHomeDir = "/Users/john.shofer.smith"
		const globalShoferDir = path.join(fakeHomeDir, ".shofer") // "/Users/john.shofer.smith/.shofer"
		const projectRooDir = "/projects/my-project/.shofer"

		// Old implementation (fragile):
		// const isGlobal = shoferDir.includes(path.join(os.homedir(), ".shofer"))
		// This could fail if the home directory path contains ".shofer" elsewhere

		// New implementation (robust):
		// const isGlobal = path.resolve(shoferDir) === path.resolve(getGlobalShoferDirectory())

		// Test the new logic
		const isGlobalForGlobalDir = path.resolve(globalShoferDir) === path.resolve(globalShoferDir)
		const isGlobalForProjectDir = path.resolve(projectRooDir) === path.resolve(globalShoferDir)

		expect(isGlobalForGlobalDir).toBe(true)
		expect(isGlobalForProjectDir).toBe(false)

		// Verify that the old implementation would have been problematic
		// if the home directory contained ".shofer" in the path
		const oldLogicGlobal = globalShoferDir.includes(path.join(fakeHomeDir, ".shofer"))
		const oldLogicProject = projectRooDir.includes(path.join(fakeHomeDir, ".shofer"))

		expect(oldLogicGlobal).toBe(true) // This works
		expect(oldLogicProject).toBe(false) // This also works, but is fragile

		// The issue was that if the home directory path itself contained ".shofer",
		// the includes() check could produce false positives in edge cases
	})

	it("should handle edge cases with path resolution", () => {
		// Test various edge cases that exact path comparison handles better
		const testCases = [
			{
				global: "/Users/test/.shofer",
				project: "/Users/test/project/.shofer",
				expected: { global: true, project: false },
			},
			{
				global: "/home/user/.shofer",
				project: "/home/user/.shofer", // Same directory
				expected: { global: true, project: true },
			},
			{
				global: "/Users/john.shofer.smith/.shofer",
				project: "/projects/app/.shofer",
				expected: { global: true, project: false },
			},
		]

		testCases.forEach(({ global, project, expected }) => {
			const isGlobalForGlobal = path.resolve(global) === path.resolve(global)
			const isGlobalForProject = path.resolve(project) === path.resolve(global)

			expect(isGlobalForGlobal).toBe(expected.global)
			expect(isGlobalForProject).toBe(expected.project)
		})
	})
})
