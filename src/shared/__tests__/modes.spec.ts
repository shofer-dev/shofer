// npx vitest run shared/__tests__/modes.spec.ts

import type { ModeConfig, PromptComponent } from "@shofer/types"

// Mock setup must come before imports
vi.mock("vscode")

import { FileRestrictionError, modes, getModeSelection } from "../modes"
import { isToolAllowedForMode } from "../../core/tools/validateToolUse"

describe("isToolAllowedForMode", () => {
	const customModes: ModeConfig[] = [
		{
			slug: "markdown-editor",
			name: "Markdown Editor",
			roleDefinition: "You are a markdown editor",
			groups: ["read", ["write", { fileRegex: "\\.md$" }]],
		},
		{
			slug: "css-editor",
			name: "CSS Editor",
			roleDefinition: "You are a CSS editor",
			groups: ["read", ["write", { fileRegex: "\\.css$" }]],
		},
		{
			slug: "test-exp-mode",
			name: "Test Exp Mode",
			roleDefinition: "You are an experimental tester",
			groups: ["read", "write"],
		},
	]

	it("allows always available tools", () => {
		expect(isToolAllowedForMode("attempt_completion", "markdown-editor", customModes)).toBe(true)
		expect(isToolAllowedForMode("set_task_title", "markdown-editor", customModes)).toBe(true)
	})

	it("allows unrestricted tools", () => {
		expect(isToolAllowedForMode("read_file", "markdown-editor", customModes)).toBe(true)
	})

	describe("file restrictions", () => {
		it("allows editing matching files", () => {
			// Test markdown editor mode
			const mdResult = isToolAllowedForMode("write_to_file", "markdown-editor", customModes, undefined, {
				path: "test.md",
				content: "# Test",
			})
			expect(mdResult).toBe(true)

			// Test CSS editor mode
			const cssResult = isToolAllowedForMode("write_to_file", "css-editor", customModes, undefined, {
				path: "styles.css",
				content: ".test { color: red; }",
			})
			expect(cssResult).toBe(true)
		})

		it("rejects editing non-matching files", () => {
			// Test markdown editor mode with non-markdown file
			expect(() =>
				isToolAllowedForMode("write_to_file", "markdown-editor", customModes, undefined, {
					path: "test.js",
					content: "console.log('test')",
				}),
			).toThrow(FileRestrictionError)
			expect(() =>
				isToolAllowedForMode("write_to_file", "markdown-editor", customModes, undefined, {
					path: "test.js",
					content: "console.log('test')",
				}),
			).toThrow(/\\.md\$/)

			// Test CSS editor mode with non-CSS file
			expect(() =>
				isToolAllowedForMode("write_to_file", "css-editor", customModes, undefined, {
					path: "test.js",
					content: "console.log('test')",
				}),
			).toThrow(FileRestrictionError)
			expect(() =>
				isToolAllowedForMode("write_to_file", "css-editor", customModes, undefined, {
					path: "test.js",
					content: "console.log('test')",
				}),
			).toThrow(/\\.css\$/)
		})

		it("handles partial streaming cases (path only, no content/diff)", () => {
			// Should allow path-only for matching files (no validation yet since content/diff not provided)
			expect(
				isToolAllowedForMode("write_to_file", "markdown-editor", customModes, undefined, {
					path: "test.js",
				}),
			).toBe(true)

			expect(
				isToolAllowedForMode("apply_diff", "markdown-editor", customModes, undefined, {
					path: "test.js",
				}),
			).toBe(true)

			// Should allow path-only for architect mode too
			expect(
				isToolAllowedForMode("write_to_file", "architect", [], undefined, {
					path: "test.js",
				}),
			).toBe(true)
		})

		it("applies restrictions to both write_to_file and apply_diff", () => {
			// Test write_to_file
			const writeResult = isToolAllowedForMode("write_to_file", "markdown-editor", customModes, undefined, {
				path: "test.md",
				content: "# Test",
			})
			expect(writeResult).toBe(true)

			// Test apply_diff
			const diffResult = isToolAllowedForMode("apply_diff", "markdown-editor", customModes, undefined, {
				path: "test.md",
				diff: "- old\n+ new",
			})
			expect(diffResult).toBe(true)

			// Test both with non-matching file
			expect(() =>
				isToolAllowedForMode("write_to_file", "markdown-editor", customModes, undefined, {
					path: "test.js",
					content: "console.log('test')",
				}),
			).toThrow(FileRestrictionError)

			expect(() =>
				isToolAllowedForMode("apply_diff", "markdown-editor", customModes, undefined, {
					path: "test.js",
					diff: "- old\n+ new",
				}),
			).toThrow(FileRestrictionError)
		})

		it("uses description in file restriction error for custom modes", () => {
			const customModesWithDescription: ModeConfig[] = [
				{
					slug: "docs-editor",
					name: "Documentation Editor",
					roleDefinition: "You are a documentation editor",
					groups: ["read", ["write", { fileRegex: "\\.(md|txt)$", description: "Documentation files only" }]],
				},
			]

			// Test write_to_file with non-matching file
			expect(() =>
				isToolAllowedForMode("write_to_file", "docs-editor", customModesWithDescription, undefined, {
					path: "test.js",
					content: "console.log('test')",
				}),
			).toThrow(FileRestrictionError)
			expect(() =>
				isToolAllowedForMode("write_to_file", "docs-editor", customModesWithDescription, undefined, {
					path: "test.js",
					content: "console.log('test')",
				}),
			).toThrow(/Documentation files only/)

			// Test apply_diff with non-matching file
			expect(() =>
				isToolAllowedForMode("apply_diff", "docs-editor", customModesWithDescription, undefined, {
					path: "test.js",
					diff: "- old\n+ new",
				}),
			).toThrow(FileRestrictionError)
			expect(() =>
				isToolAllowedForMode("apply_diff", "docs-editor", customModesWithDescription, undefined, {
					path: "test.js",
					diff: "- old\n+ new",
				}),
			).toThrow(/Documentation files only/)

			// Test that matching files are allowed
			expect(
				isToolAllowedForMode("write_to_file", "docs-editor", customModesWithDescription, undefined, {
					path: "test.md",
					content: "# Test",
				}),
			).toBe(true)

			expect(
				isToolAllowedForMode("write_to_file", "docs-editor", customModesWithDescription, undefined, {
					path: "test.txt",
					content: "Test content",
				}),
			).toBe(true)

			// Test partial streaming cases
			expect(
				isToolAllowedForMode("write_to_file", "docs-editor", customModesWithDescription, undefined, {
					path: "test.js",
				}),
			).toBe(true)
		})

		it("allows architect mode to edit markdown files only", () => {
			// Should allow editing markdown files
			expect(
				isToolAllowedForMode("write_to_file", "architect", [], undefined, {
					path: "test.md",
					content: "# Test",
				}),
			).toBe(true)

			// Should allow applying diffs to markdown files
			expect(
				isToolAllowedForMode("apply_diff", "architect", [], undefined, {
					path: "readme.md",
					diff: "- old\n+ new",
				}),
			).toBe(true)

			// Should reject non-markdown files
			expect(() =>
				isToolAllowedForMode("write_to_file", "architect", [], undefined, {
					path: "test.js",
					content: "console.log('test')",
				}),
			).toThrow(FileRestrictionError)
			expect(() =>
				isToolAllowedForMode("write_to_file", "architect", [], undefined, {
					path: "test.js",
					content: "console.log('test')",
				}),
			).toThrow(/Markdown files only/)

			// Should maintain read capabilities
			expect(isToolAllowedForMode("read_file", "architect", [])).toBe(true)
			expect(isToolAllowedForMode("use_mcp_tool", "architect", [])).toBe(true)
		})

		it("applies restrictions to apply_diff", () => {
			// Native-only: file restrictions for apply_diff are enforced against the top-level `path`.

			// Should allow markdown files in architect mode
			expect(
				isToolAllowedForMode("apply_diff", "architect", [], undefined, {
					path: "test.md",
					diff: "- old content\n+ new content",
				}),
			).toBe(true)

			// Non-markdown file should throw
			expect(() =>
				isToolAllowedForMode("apply_diff", "architect", [], undefined, {
					path: "test.py",
					diff: "- old content\n+ new content",
				}),
			).toThrow(FileRestrictionError)
			expect(() =>
				isToolAllowedForMode("apply_diff", "architect", [], undefined, {
					path: "test.py",
					diff: "- old content\n+ new content",
				}),
			).toThrow(/Markdown files only/)
		})

		it("applies restrictions to apply_patch (custom tool)", () => {
			// Test that apply_patch respects file restrictions when included
			// Note: apply_patch only accepts { patch: string } - file paths are embedded in patch content
			const patchResult = isToolAllowedForMode(
				"apply_patch",
				"markdown-editor",
				customModes,
				undefined,
				{
					patch: "*** Begin Patch\n*** Update File: test.md\n@@ \n-old\n+new\n*** End Patch",
				},
				undefined,
				["apply_patch"], // Include custom tool
			)
			expect(patchResult).toBe(true)

			// Test apply_patch with non-matching file (file path embedded in patch content)
			expect(() =>
				isToolAllowedForMode(
					"apply_patch",
					"markdown-editor",
					customModes,
					undefined,
					{
						patch: "*** Begin Patch\n*** Update File: test.js\n@@ \n-old\n+new\n*** End Patch",
					},
					undefined,
					["apply_patch"], // Include custom tool
				),
			).toThrow(FileRestrictionError)
			expect(() =>
				isToolAllowedForMode(
					"apply_patch",
					"markdown-editor",
					customModes,
					undefined,
					{
						patch: "*** Begin Patch\n*** Update File: test.js\n@@ \n-old\n+new\n*** End Patch",
					},
					undefined,
					["apply_patch"], // Include custom tool
				),
			).toThrow(/\\.md\$/)
		})

		it("applies restrictions to search_replace (custom tool)", () => {
			// Test that search_replace respects file restrictions when included
			const searchReplaceResult = isToolAllowedForMode(
				"search_replace",
				"markdown-editor",
				customModes,
				undefined,
				{
					file_path: "test.md",
					old_string: "old text",
					new_string: "new text",
				},
				undefined,
				["search_replace"], // Include custom tool
			)
			expect(searchReplaceResult).toBe(true)

			// Test search_replace with non-matching file
			expect(() =>
				isToolAllowedForMode(
					"search_replace",
					"markdown-editor",
					customModes,
					undefined,
					{
						file_path: "test.js",
						old_string: "old text",
						new_string: "new text",
					},
					undefined,
					["search_replace"], // Include custom tool
				),
			).toThrow(FileRestrictionError)
			expect(() =>
				isToolAllowedForMode(
					"search_replace",
					"markdown-editor",
					customModes,
					undefined,
					{
						file_path: "test.js",
						old_string: "old text",
						new_string: "new text",
					},
					undefined,
					["search_replace"], // Include custom tool
				),
			).toThrow(/\\.md\$/)
		})

		it("applies restrictions to edit_file (custom tool)", () => {
			// Test that edit_file respects file restrictions when included
			const editFileResult = isToolAllowedForMode(
				"edit_file",
				"markdown-editor",
				customModes,
				undefined,
				{
					file_path: "test.md",
					old_string: "old text",
					new_string: "new text",
				},
				undefined,
				["edit_file"], // Include custom tool
			)
			expect(editFileResult).toBe(true)

			// Test edit_file with non-matching file
			expect(() =>
				isToolAllowedForMode(
					"edit_file",
					"markdown-editor",
					customModes,
					undefined,
					{
						file_path: "test.js",
						old_string: "old text",
						new_string: "new text",
					},
					undefined,
					["edit_file"], // Include custom tool
				),
			).toThrow(FileRestrictionError)
			expect(() =>
				isToolAllowedForMode(
					"edit_file",
					"markdown-editor",
					customModes,
					undefined,
					{
						file_path: "test.js",
						old_string: "old text",
						new_string: "new text",
					},
					undefined,
					["edit_file"], // Include custom tool
				),
			).toThrow(/\\.md\$/)
		})

		it("applies restrictions to all editing tools in architect mode (custom tools)", () => {
			// Test apply_patch in architect mode
			// Note: apply_patch only accepts { patch: string } - file paths are embedded in patch content
			expect(
				isToolAllowedForMode(
					"apply_patch",
					"architect",
					[],
					undefined,
					{
						patch: "*** Begin Patch\n*** Update File: test.md\n@@ \n-old\n+new\n*** End Patch",
					},
					undefined,
					["apply_patch"], // Include custom tool
				),
			).toBe(true)

			expect(() =>
				isToolAllowedForMode(
					"apply_patch",
					"architect",
					[],
					undefined,
					{
						patch: "*** Begin Patch\n*** Update File: test.js\n@@ \n-old\n+new\n*** End Patch",
					},
					undefined,
					["apply_patch"], // Include custom tool
				),
			).toThrow(FileRestrictionError)

			// Test search_replace in architect mode
			expect(
				isToolAllowedForMode(
					"search_replace",
					"architect",
					[],
					undefined,
					{
						file_path: "test.md",
						old_string: "old text",
						new_string: "new text",
					},
					undefined,
					["search_replace"], // Include custom tool
				),
			).toBe(true)

			expect(() =>
				isToolAllowedForMode(
					"search_replace",
					"architect",
					[],
					undefined,
					{
						file_path: "test.js",
						old_string: "old text",
						new_string: "new text",
					},
					undefined,
					["search_replace"], // Include custom tool
				),
			).toThrow(FileRestrictionError)

			// Test edit_file in architect mode
			expect(
				isToolAllowedForMode(
					"edit_file",
					"architect",
					[],
					undefined,
					{
						file_path: "test.md",
						old_string: "old text",
						new_string: "new text",
					},
					undefined,
					["edit_file"], // Include custom tool
				),
			).toBe(true)

			expect(() =>
				isToolAllowedForMode(
					"edit_file",
					"architect",
					[],
					undefined,
					{
						file_path: "test.js",
						old_string: "old text",
						new_string: "new text",
					},
					undefined,
					["edit_file"], // Include custom tool
				),
			).toThrow(FileRestrictionError)
		})
		it("enforces fileRegex for sed (previously bypassed)", () => {
			expect(
				isToolAllowedForMode("sed", "markdown-editor", customModes, undefined, {
					path: "test.md",
					pattern: "foo",
					replacement: "bar",
				}),
			).toBe(true)

			expect(() =>
				isToolAllowedForMode("sed", "markdown-editor", customModes, undefined, {
					path: "test.js",
					pattern: "foo",
					replacement: "bar",
				}),
			).toThrow(FileRestrictionError)
			expect(() =>
				isToolAllowedForMode("sed", "markdown-editor", customModes, undefined, {
					path: "test.js",
					pattern: "foo",
					replacement: "bar",
				}),
			).toThrow(/\\.md\$/)
		})

		it("enforces fileRegex for file rm (previously bypassed)", () => {
			expect(
				isToolAllowedForMode("file", "markdown-editor", customModes, undefined, {
					subcommand: "rm",
					path: "test.md",
				}),
			).toBe(true)

			expect(() =>
				isToolAllowedForMode("file", "markdown-editor", customModes, undefined, {
					subcommand: "rm",
					path: "test.js",
				}),
			).toThrow(FileRestrictionError)
			expect(() =>
				isToolAllowedForMode("file", "markdown-editor", customModes, undefined, {
					subcommand: "rm",
					path: "test.js",
				}),
			).toThrow(/\\.md\$/)
		})

		it("enforces fileRegex for file mv — source and destination (previously bypassed)", () => {
			expect(
				isToolAllowedForMode("file", "markdown-editor", customModes, undefined, {
					subcommand: "mv",
					path: "test.md",
					destination: "renamed.md",
				}),
			).toBe(true)

			expect(() =>
				isToolAllowedForMode("file", "markdown-editor", customModes, undefined, {
					subcommand: "mv",
					path: "test.md",
					destination: "renamed.js",
				}),
			).toThrow(FileRestrictionError)
		})

		it("enforces fileRegex for create_directory (previously bypassed)", () => {
			expect(
				isToolAllowedForMode("create_directory", "markdown-editor", customModes, undefined, {
					path: "docs/readme.md",
				}),
			).toBe(true)

			expect(() =>
				isToolAllowedForMode("create_directory", "markdown-editor", customModes, undefined, {
					path: "src/app.js",
				}),
			).toThrow(FileRestrictionError)
		})

		it("enforces fileRegex for create_new_workspace (previously bypassed)", () => {
			expect(
				isToolAllowedForMode("create_new_workspace", "markdown-editor", customModes, undefined, {
					path: "/tmp",
					name: "test.md",
				}),
			).toBe(true)

			expect(() =>
				isToolAllowedForMode("create_new_workspace", "markdown-editor", customModes, undefined, {
					path: "/tmp",
					name: "test",
				}),
			).toThrow(FileRestrictionError)
		})

		it("enforces fileRegex for generate_image (previously bypassed)", () => {
			expect(
				isToolAllowedForMode("generate_image", "markdown-editor", customModes, undefined, {
					prompt: "a cat",
					path: "images/output.md",
				}),
			).toBe(true)

			expect(() =>
				isToolAllowedForMode("generate_image", "markdown-editor", customModes, undefined, {
					prompt: "a cat",
					path: "images/output.png",
				}),
			).toThrow(FileRestrictionError)
		})

		it("enforces fileRegex for insert_edit (path and filePath alias)", () => {
			expect(
				isToolAllowedForMode("insert_edit", "markdown-editor", customModes, undefined, {
					path: "test.md",
					line: 3,
					text: "hello",
				}),
			).toBe(true)
			expect(
				isToolAllowedForMode("insert_edit", "markdown-editor", customModes, undefined, {
					filePath: "test.md",
					line: 3,
					text: "hello",
				}),
			).toBe(true)

			expect(() =>
				isToolAllowedForMode("insert_edit", "markdown-editor", customModes, undefined, {
					path: "test.js",
					line: 3,
					text: "hello",
				}),
			).toThrow(FileRestrictionError)
			expect(() =>
				isToolAllowedForMode("insert_edit", "markdown-editor", customModes, undefined, {
					filePath: "test.js",
					line: 3,
					text: "hello",
				}),
			).toThrow(FileRestrictionError)
		})

		it("enforces fileRegex for rename_symbol (previously partial)", () => {
			expect(
				isToolAllowedForMode("rename_symbol", "markdown-editor", customModes, undefined, {
					path: "test.md",
					line: 1,
					column: 1,
					newName: "foo",
				}),
			).toBe(true)

			expect(() =>
				isToolAllowedForMode("rename_symbol", "markdown-editor", customModes, undefined, {
					path: "test.js",
					line: 1,
					column: 1,
					newName: "foo",
				}),
			).toThrow(FileRestrictionError)
		})

		it("skips fileRegex enforcement during streaming partial params (gating)", () => {
			// write_to_file gates on `content` — no enforcement without it
			expect(
				isToolAllowedForMode("write_to_file", "markdown-editor", customModes, undefined, {
					path: "test.js",
				}),
			).toBe(true)
			// apply_diff gates on `diff`
			expect(
				isToolAllowedForMode("apply_diff", "markdown-editor", customModes, undefined, {
					path: "test.js",
				}),
			).toBe(true)
			// sed gates on `pattern` or `replacement`
			expect(
				isToolAllowedForMode("sed", "markdown-editor", customModes, undefined, {
					path: "test.js",
				}),
			).toBe(true)
			// file gates on `subcommand` — path-only is gated
			expect(
				isToolAllowedForMode("file", "markdown-editor", customModes, undefined, {
					path: "test.js",
				}),
			).toBe(true)
			// generate_image gates on `prompt` — path-only is gated
			expect(
				isToolAllowedForMode("generate_image", "markdown-editor", customModes, undefined, {
					path: "test.js",
				}),
			).toBe(true)
			// create_directory has no gating params — validates immediately
			expect(() =>
				isToolAllowedForMode("create_directory", "markdown-editor", customModes, undefined, {
					path: "test.js",
				}),
			).toThrow(FileRestrictionError)
		})
	})

	it("handles non-existent modes", () => {
		expect(isToolAllowedForMode("write_to_file", "non-existent", customModes)).toBe(false)
	})

	it("respects tool requirements", () => {
		const toolRequirements = {
			write_to_file: false,
		}

		expect(isToolAllowedForMode("write_to_file", "markdown-editor", customModes, toolRequirements)).toBe(false)
	})

	describe("customTools (opt-in tools)", () => {
		const customModesWithEditGroup: ModeConfig[] = [
			{
				slug: "test-custom-tools",
				name: "Test Custom Tools Mode",
				roleDefinition: "You are a test mode",
				groups: ["read", "write"],
			},
		]

		it("disallows customTools by default (not in includedTools)", () => {
			// search_and_replace is a customTool in the edit group, should be disallowed by default
			expect(isToolAllowedForMode("search_and_replace", "test-custom-tools", customModesWithEditGroup)).toBe(
				false,
			)
		})

		it("allows customTools when included in includedTools", () => {
			// search_and_replace should be allowed when explicitly included
			expect(
				isToolAllowedForMode(
					"search_and_replace",
					"test-custom-tools",
					customModesWithEditGroup,
					undefined,
					undefined,
					undefined,
					["search_and_replace"],
				),
			).toBe(true)
		})

		it("disallows customTools even in includedTools if mode doesn't have the group", () => {
			const customModesWithoutEdit: ModeConfig[] = [
				{
					slug: "no-edit-mode",
					name: "No Edit Mode",
					roleDefinition: "You have no edit powers",
					groups: ["read"], // No edit group
				},
			]

			// Even if included, should be disallowed because the mode doesn't have edit group
			expect(
				isToolAllowedForMode(
					"search_and_replace",
					"no-edit-mode",
					customModesWithoutEdit,
					undefined,
					undefined,
					undefined,
					["search_and_replace"],
				),
			).toBe(false)
		})

		it("allows regular tools in the same group as customTools", () => {
			// apply_diff (regular tool) should be allowed even without includedTools
			expect(isToolAllowedForMode("apply_diff", "test-custom-tools", customModesWithEditGroup)).toBe(true)
			expect(isToolAllowedForMode("write_to_file", "test-custom-tools", customModesWithEditGroup)).toBe(true)
		})
	})
})

describe("FileRestrictionError", () => {
	it("formats error message with pattern when no description provided", () => {
		const error = new FileRestrictionError("Markdown Editor", "\\.md$", undefined, "test.js")
		expect(error.message).toBe(
			"This mode (Markdown Editor) can only edit files matching pattern: \\.md$. Got: test.js",
		)
		expect(error.name).toBe("FileRestrictionError")
	})

	it("formats error message with tool name when provided", () => {
		const error = new FileRestrictionError("Markdown Editor", "\\.md$", undefined, "test.js", "write_to_file")
		expect(error.message).toBe(
			"Tool 'write_to_file' in mode 'Markdown Editor' can only edit files matching pattern: \\.md$. Got: test.js",
		)
		expect(error.name).toBe("FileRestrictionError")
	})

	describe("debug mode", () => {
		it("is configured correctly", () => {
			const debugMode = modes.find((mode) => mode.slug === "debug")
			expect(debugMode).toBeDefined()
			expect(debugMode).toMatchObject({
				slug: "debug",
				name: "🪲 Debug",
				roleDefinition:
					"You are Shofer, an expert software debugger specializing in systematic problem diagnosis and resolution.",
				groups: ["read", "write", "execute", "mcp", "subtasks", "questions", "uncategorized"],
			})
			expect(debugMode?.customInstructions).toContain(
				"Reflect on 5-7 different possible sources of the problem, distill those down to 1-2 most likely sources, and then add logs to validate your assumptions. Explicitly ask the user to confirm the diagnosis before fixing the problem.",
			)
		})
	})

	describe("getFullModeDetails", () => {
		it("is tested in src/core/modes/__tests__/getFullModeDetails.test.ts (host-only)", () => {
			// Moved to src/core/modes/__tests__/getFullModeDetails.test.ts (host-only)
			// because getFullModeDetails transitively depends on fs/path/os via
			// addCustomInstructions and must not be importable from the webview bundle.
			// See the Shared Module Isolation Rule in AGENTS.md.
			expect(true).toBe(true)
		})
	})

	it("formats error message with description when provided", () => {
		const error = new FileRestrictionError("Markdown Editor", "\\.md$", "Markdown files only", "test.js")
		expect(error.message).toBe(
			"This mode (Markdown Editor) can only edit files matching pattern: \\.md$ (Markdown files only). Got: test.js",
		)
		expect(error.name).toBe("FileRestrictionError")
	})

	it("formats error message with both tool name and description when provided", () => {
		const error = new FileRestrictionError(
			"Markdown Editor",
			"\\.md$",
			"Markdown files only",
			"test.js",
			"apply_diff",
		)
		expect(error.message).toBe(
			"Tool 'apply_diff' in mode 'Markdown Editor' can only edit files matching pattern: \\.md$ (Markdown files only). Got: test.js",
		)
		expect(error.name).toBe("FileRestrictionError")
	})
})

describe("getModeSelection", () => {
	const builtInDebugMode = modes.find((m) => m.slug === "debug")!
	const customModesList: ModeConfig[] = [
		{
			slug: "code", // Override
			name: "Custom Code Mode",
			roleDefinition: "Custom Code Role",
			customInstructions: "Custom Code Instructions",
			groups: ["read"],
		},
		{
			slug: "new-custom",
			name: "New Custom Mode",
			roleDefinition: "New Custom Role",
			customInstructions: "New Custom Instructions",
			groups: ["write"],
		},
	]

	const promptComponentCode: PromptComponent = {
		roleDefinition: "Prompt Component Code Role",
		customInstructions: "Prompt Component Code Instructions",
	}

	const promptComponentDebug: PromptComponent = {
		roleDefinition: "Prompt Component Debug Role",
		customInstructions: "Prompt Component Debug Instructions",
	}

	test("should return built-in mode details if no overrides", () => {
		const selection = getModeSelection("debug")
		expect(selection.roleDefinition).toBe(builtInDebugMode.roleDefinition)
		expect(selection.baseInstructions).toBe(builtInDebugMode.customInstructions || "")
	})

	test("should prioritize promptComponent for built-in mode if no custom mode exists for that slug", () => {
		const selection = getModeSelection("debug", promptComponentDebug) // "debug" is not in customModesList
		expect(selection.roleDefinition).toBe(promptComponentDebug.roleDefinition)
		expect(selection.baseInstructions).toBe(promptComponentDebug.customInstructions)
	})

	test("should prioritize customMode over built-in mode", () => {
		const selection = getModeSelection("code", undefined, customModesList)
		const customCode = customModesList.find((m) => m.slug === "code")!
		expect(selection.roleDefinition).toBe(customCode.roleDefinition)
		expect(selection.baseInstructions).toBe(customCode.customInstructions)
	})

	test("should prioritize customMode over promptComponent and built-in mode", () => {
		const selection = getModeSelection("code", promptComponentCode, customModesList)
		const customCode = customModesList.find((m) => m.slug === "code")!
		expect(selection.roleDefinition).toBe(customCode.roleDefinition)
		expect(selection.baseInstructions).toBe(customCode.customInstructions)
	})

	test("should return new custom mode details if it exists", () => {
		const selection = getModeSelection("new-custom", undefined, customModesList)
		const newCustom = customModesList.find((m) => m.slug === "new-custom")!
		expect(selection.roleDefinition).toBe(newCustom.roleDefinition)
		expect(selection.baseInstructions).toBe(newCustom.customInstructions)
	})

	test("customMode takes precedence for a new custom mode even if promptComponent is provided", () => {
		const promptComponentNew: PromptComponent = {
			roleDefinition: "Prompt New Custom Role",
			customInstructions: "Prompt New Custom Instructions",
		}
		const selection = getModeSelection("new-custom", promptComponentNew, customModesList)
		const newCustomMode = customModesList.find((m) => m.slug === "new-custom")!
		expect(selection.roleDefinition).toBe(newCustomMode.roleDefinition)
		expect(selection.baseInstructions).toBe(newCustomMode.customInstructions)
	})

	test("should fall back to default mode if slug does not exist in custom, prompt, or built-in modes", () => {
		const selection = getModeSelection("non-existent-mode", undefined, customModesList)
		const defaultMode = modes[0] // First mode is the default
		expect(selection.roleDefinition).toBe(defaultMode.roleDefinition)
		expect(selection.baseInstructions).toBe(defaultMode.customInstructions || "")
	})

	test("customMode's properties are used if customMode exists, ignoring promptComponent's properties", () => {
		const selection = getModeSelection(
			"code",
			{ roleDefinition: "Prompt Role Only", customInstructions: "Prompt Instructions Only" },
			customModesList,
		)
		const customCodeMode = customModesList.find((m) => m.slug === "code")!
		expect(selection.roleDefinition).toBe(customCodeMode.roleDefinition) // Takes from customCodeMode
		expect(selection.baseInstructions).toBe(customCodeMode.customInstructions) // Takes from customCodeMode
	})

	test("handles undefined customInstructions in customMode gracefully", () => {
		const modesWithoutCustomInstructions: ModeConfig[] = [
			{
				slug: "no-instr",
				name: "No Instructions Mode",
				roleDefinition: "Role for no instructions",
				groups: ["read"],
				// customInstructions is undefined
			},
		]
		const selection = getModeSelection("no-instr", undefined, modesWithoutCustomInstructions)
		expect(selection.roleDefinition).toBe("Role for no instructions")
		expect(selection.baseInstructions).toBe("") // Defaults to empty string
	})

	test("handles empty or undefined roleDefinition in customMode gracefully", () => {
		const modesWithEmptyRoleDef: ModeConfig[] = [
			{
				slug: "empty-role",
				name: "Empty Role Mode",
				roleDefinition: "",
				customInstructions: "Instructions for empty role",
				groups: ["read"],
			},
		]
		const selection = getModeSelection("empty-role", undefined, modesWithEmptyRoleDef)
		expect(selection.roleDefinition).toBe("")
		expect(selection.baseInstructions).toBe("Instructions for empty role")

		const modesWithUndefinedRoleDef: ModeConfig[] = [
			{
				slug: "undefined-role",
				name: "Undefined Role Mode",
				roleDefinition: "", // Test undefined explicitly by using an empty string
				customInstructions: "Instructions for undefined role",
				groups: ["read"],
			},
		]
		const selection2 = getModeSelection("undefined-role", undefined, modesWithUndefinedRoleDef)
		expect(selection2.roleDefinition).toBe("")
		expect(selection2.baseInstructions).toBe("Instructions for undefined role")
	})

	test("customMode's defined properties take precedence, undefined ones in customMode result in ''", () => {
		const customModeRoleOnlyList: ModeConfig[] = [
			// Renamed for clarity
			{
				slug: "role-custom",
				name: "Role Custom",
				roleDefinition: "Custom Role Only",
				groups: ["read"] /* customInstructions undefined */,
			},
		]
		const promptComponentInstrOnly: PromptComponent = { customInstructions: "Prompt Instructions Only" }
		// "role-custom" exists in customModeRoleOnlyList
		const selection = getModeSelection("role-custom", promptComponentInstrOnly, customModeRoleOnlyList)
		// customMode is chosen.
		expect(selection.roleDefinition).toBe("Custom Role Only") // From customMode
		expect(selection.baseInstructions).toBe("") // From customMode (undefined || '' -> '')
	})

	test("customMode's defined properties take precedence, empty string ones in customMode are used", () => {
		const customModeInstrOnlyList: ModeConfig[] = [
			// Renamed for clarity
			{
				slug: "instr-custom",
				name: "Instr Custom",
				roleDefinition: "", // Explicitly empty
				customInstructions: "Custom Instructions Only",
				groups: ["read"],
			},
		]
		const promptComponentRoleOnly: PromptComponent = { roleDefinition: "Prompt Role Only" }
		// "instr-custom" exists in customModeInstrOnlyList
		const selection = getModeSelection("instr-custom", promptComponentRoleOnly, customModeInstrOnlyList)
		// customMode is chosen
		expect(selection.roleDefinition).toBe("") // From customMode ( "" || '' -> "")
		expect(selection.baseInstructions).toBe("Custom Instructions Only") // From customMode
	})

	test("customMode with empty/undefined fields takes precedence over promptComponent and builtInMode", () => {
		const customModeMinimal: ModeConfig[] = [
			{ slug: "debug", name: "Custom Debug Minimal", roleDefinition: "", groups: ["read"] }, // roleDef empty, customInstr undefined
		]
		const promptComponentMinimal: PromptComponent = {
			roleDefinition: "Prompt Min Role",
			customInstructions: "Prompt Min Instr",
		}
		// "debug" is in customModeMinimal
		const selection = getModeSelection("debug", promptComponentMinimal, customModeMinimal)
		// customMode is chosen
		expect(selection.roleDefinition).toBe("") // From customModeMinimal
		expect(selection.baseInstructions).toBe("") // From customModeMinimal
	})

	test("promptComponent is used if customMode for slug does not exist, even if customModesList is provided", () => {
		// 'ask' is not in customModesList, but 'code' and 'new-custom' are.
		const selection = getModeSelection("debug", promptComponentDebug, customModesList)
		expect(selection.roleDefinition).toBe(promptComponentDebug.roleDefinition)
		expect(selection.baseInstructions).toBe(promptComponentDebug.customInstructions)
	})

	test("builtInMode is used if customMode for slug does not exist and promptComponent is not provided", () => {
		// 'ask' is not in customModesList
		const selection = getModeSelection("debug", undefined, customModesList)
		expect(selection.roleDefinition).toBe(builtInDebugMode.roleDefinition)
		expect(selection.baseInstructions).toBe(builtInDebugMode.customInstructions || "")
	})

	test("promptComponent is used if customMode is not provided (undefined customModesList)", () => {
		const selection = getModeSelection("debug", promptComponentDebug, undefined)
		expect(selection.roleDefinition).toBe(promptComponentDebug.roleDefinition)
		expect(selection.baseInstructions).toBe(promptComponentDebug.customInstructions)
	})
})
