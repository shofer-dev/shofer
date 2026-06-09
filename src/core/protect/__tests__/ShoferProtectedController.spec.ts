import path from "path"
import { ShoferProtectedController } from "../ShoferProtectedController"

describe("ShoferProtectedController", () => {
	const TEST_CWD = "/test/workspace"
	let controller: ShoferProtectedController

	beforeEach(() => {
		controller = new ShoferProtectedController(TEST_CWD)
	})

	describe("isWriteProtected", () => {
		it("should protect files in .shofer directory", () => {
			expect(controller.isWriteProtected(".shofer/config.json")).toBe(true)
			expect(controller.isWriteProtected(".shofer/settings/user.json")).toBe(true)
			expect(controller.isWriteProtected(".shofer/modes/custom.json")).toBe(true)
			expect(controller.isWriteProtected(".shofer/shoferignore")).toBe(true)
			expect(controller.isWriteProtected(".shofer/shofermodes")).toBe(true)
			expect(controller.isWriteProtected(".shofer/worktreeinclude")).toBe(true)
		})

		it("should protect .shoferprotected file", () => {
			expect(controller.isWriteProtected(".shoferprotected")).toBe(true)
		})

		it("should protect .shoferrules* files under .shofer/", () => {
			expect(controller.isWriteProtected(".shofer/shoferrules")).toBe(true)
			expect(controller.isWriteProtected(".shofer/shoferrules.md")).toBe(true)
		})

		it("should protect files in .vscode directory", () => {
			expect(controller.isWriteProtected(".vscode/settings.json")).toBe(true)
			expect(controller.isWriteProtected(".vscode/launch.json")).toBe(true)
			expect(controller.isWriteProtected(".vscode/tasks.json")).toBe(true)
		})

		it("should protect .code-workspace files", () => {
			expect(controller.isWriteProtected("myproject.code-workspace")).toBe(true)
			expect(controller.isWriteProtected("pentest.code-workspace")).toBe(true)
			expect(controller.isWriteProtected(".code-workspace")).toBe(true)
			expect(controller.isWriteProtected("folder/workspace.code-workspace")).toBe(true)
		})

		it("should protect AGENTS.md file", () => {
			expect(controller.isWriteProtected("AGENTS.md")).toBe(true)
		})

		it("should protect AGENT.md file", () => {
			expect(controller.isWriteProtected("AGENT.md")).toBe(true)
		})

		it("should not protect legacy root-level .shoferignore (now under .shofer/)", () => {
			expect(controller.isWriteProtected(".shoferignore")).toBe(false)
		})

		it("should not protect legacy root-level .shofermodes (now under .shofer/)", () => {
			expect(controller.isWriteProtected(".shofermodes")).toBe(false)
		})

		it("should not protect other files starting with .shofer", () => {
			expect(controller.isWriteProtected(".roosettings")).toBe(false)
			expect(controller.isWriteProtected(".rooconfig")).toBe(false)
		})

		it("should not protect regular files", () => {
			expect(controller.isWriteProtected("src/index.ts")).toBe(false)
			expect(controller.isWriteProtected("package.json")).toBe(false)
			expect(controller.isWriteProtected("README.md")).toBe(false)
		})

		it("should not protect files that contain 'shofer' but don't start with .shofer", () => {
			expect(controller.isWriteProtected("src/shofer-utils.ts")).toBe(false)
			expect(controller.isWriteProtected("config/shofer.config.js")).toBe(false)
		})

		it("should handle nested paths correctly", () => {
			expect(controller.isWriteProtected(".shofer/config.json")).toBe(true)
			expect(controller.isWriteProtected(".shofer/shoferignore")).toBe(true)
			expect(controller.isWriteProtected(".shofer/shofermodes")).toBe(true)
			expect(controller.isWriteProtected(".shofer/shoferrules.md")).toBe(true)
		})

		it("should handle absolute paths by converting to relative", () => {
			const absolutePath = path.join(TEST_CWD, ".shofer", "shoferignore")
			expect(controller.isWriteProtected(absolutePath)).toBe(true)
		})

		it("should handle paths with different separators", () => {
			expect(controller.isWriteProtected(".shofer\\config.json")).toBe(true)
			expect(controller.isWriteProtected(".shofer/config.json")).toBe(true)
		})

		it("should not throw for absolute paths outside cwd", () => {
			expect(controller.isWriteProtected("/tmp/comment-2-pr63.json")).toBe(false)
			expect(controller.isWriteProtected("/etc/passwd")).toBe(false)
		})
	})

	describe("getProtectedFiles", () => {
		it("should return set of protected files from a list", () => {
			const files = ["src/index.ts", ".shofer/shoferignore", "package.json", ".shofer/config.json", "README.md"]

			const protectedFiles = controller.getProtectedFiles(files)

			expect(protectedFiles).toEqual(new Set([".shofer/shoferignore", ".shofer/config.json"]))
		})

		it("should return empty set when no files are protected", () => {
			const files = ["src/index.ts", "package.json", "README.md"]

			const protectedFiles = controller.getProtectedFiles(files)

			expect(protectedFiles).toEqual(new Set())
		})
	})

	describe("annotatePathsWithProtection", () => {
		it("should annotate paths with protection status", () => {
			const files = ["src/index.ts", ".shofer/shoferignore", ".shofer/config.json", "package.json"]

			const annotated = controller.annotatePathsWithProtection(files)

			expect(annotated).toEqual([
				{ path: "src/index.ts", isProtected: false },
				{ path: ".shofer/shoferignore", isProtected: true },
				{ path: ".shofer/config.json", isProtected: true },
				{ path: "package.json", isProtected: false },
			])
		})
	})

	describe("getProtectionMessage", () => {
		it("should return appropriate protection message", () => {
			const message = controller.getProtectionMessage()
			expect(message).toBe("This is a Shofer configuration file and requires approval for modifications")
		})
	})

	describe("getInstructions", () => {
		it("should return formatted instructions about protected files", () => {
			const instructions = controller.getInstructions()

			expect(instructions).toContain("# Protected Files")
			expect(instructions).toContain("write-protected")
			expect(instructions).toContain(".shofer/**")
			expect(instructions).toContain("\u{1F6E1}") // Shield symbol
		})
	})

	describe("getProtectedPatterns", () => {
		it("should return the list of protected patterns", () => {
			const patterns = ShoferProtectedController.getProtectedPatterns()

			expect(patterns).toEqual([
				".shofer/**",
				".vscode/**",
				"*.code-workspace",
				".shoferprotected",
				"AGENTS.md",
				"AGENT.md",
			])
		})
	})
})
