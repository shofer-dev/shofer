// npx vitest src/core/config/__tests__/ModeConfig.spec.ts

import { ZodError } from "zod"

import { type ModeConfig, modeConfigSchema } from "@shofer/types"

function validateCustomMode(mode: unknown): asserts mode is ModeConfig {
	modeConfigSchema.parse(mode)
}

describe("CustomModeSchema", () => {
	describe("validateCustomMode", () => {
		test("accepts valid mode configuration", () => {
			const validMode = {
				slug: "test",
				name: "Test Mode",
				roleDefinition: "Test role definition",
				tools: ["read"] as const,
			} satisfies ModeConfig

			expect(() => validateCustomMode(validMode)).not.toThrow()
		})

		test("accepts mode with multiple tool groups", () => {
			const validMode = {
				slug: "test",
				name: "Test Mode",
				roleDefinition: "Test role definition",
				tools: ["read", "write"] as const,
			} satisfies ModeConfig

			expect(() => validateCustomMode(validMode)).not.toThrow()
		})

		test("accepts mode with optional customInstructions", () => {
			const validMode = {
				slug: "test",
				name: "Test Mode",
				roleDefinition: "Test role definition",
				customInstructions: "Custom instructions",
				tools: ["read"] as const,
			} satisfies ModeConfig

			expect(() => validateCustomMode(validMode)).not.toThrow()
		})

		test("rejects missing required fields", () => {
			const invalidModes = [
				{}, // All fields missing
				{ name: "Test" }, // Missing most fields
				{
					name: "Test",
					roleDefinition: "Role",
				}, // Missing slug and tools
			]

			invalidModes.forEach((invalidMode) => {
				expect(() => validateCustomMode(invalidMode)).toThrow(ZodError)
			})
		})

		test("rejects invalid slug format", () => {
			const invalidMode = {
				slug: "not@a@valid@slug",
				name: "Test Mode",
				roleDefinition: "Test role definition",
				tools: ["read"] as const,
			} satisfies Omit<ModeConfig, "slug"> & { slug: string }

			expect(() => validateCustomMode(invalidMode)).toThrow(ZodError)
		})

		test("rejects empty strings in required fields", () => {
			const emptyNameMode = {
				slug: "123e4567-e89b-12d3-a456-426614174000",
				name: "",
				roleDefinition: "Test role definition",
				tools: ["read"] as const,
			} satisfies ModeConfig

			const emptyRoleMode = {
				slug: "123e4567-e89b-12d3-a456-426614174000",
				name: "Test Mode",
				roleDefinition: "",
				tools: ["read"] as const,
			} satisfies ModeConfig

			expect(() => validateCustomMode(emptyNameMode)).toThrow(ZodError)
			expect(() => validateCustomMode(emptyRoleMode)).toThrow(ZodError)
		})

		test("rejects invalid group configurations", () => {
			const invalidGroupMode = {
				slug: "123e4567-e89b-12d3-a456-426614174000",
				name: "Test Mode",
				roleDefinition: "Test role definition",
				tools: ["not-a-valid-group"] as any,
			}

			expect(() => validateCustomMode(invalidGroupMode)).toThrow(ZodError)
		})

		test("handles null and undefined gracefully", () => {
			expect(() => validateCustomMode(null)).toThrow(ZodError)
			expect(() => validateCustomMode(undefined)).toThrow(ZodError)
		})

		test("rejects non-object inputs", () => {
			const invalidInputs = [42, "string", true, [], () => {}]

			invalidInputs.forEach((input) => {
				expect(() => validateCustomMode(input)).toThrow(ZodError)
			})
		})
	})

	describe("fileRegex", () => {
		it("validates a mode with file restrictions and descriptions", () => {
			const modeWithJustRegex = {
				slug: "markdown-editor",
				name: "Markdown Editor",
				roleDefinition: "Markdown editing mode",
				tools: ["read", ["write", { fileRegex: "\\.md$" }]],
			}

			const modeWithDescription = {
				slug: "docs-editor",
				name: "Documentation Editor",
				roleDefinition: "Documentation editing mode",
				tools: ["read", ["write", { fileRegex: "\\.(md|txt)$", description: "Documentation files only" }]],
			}

			expect(() => modeConfigSchema.parse(modeWithJustRegex)).not.toThrow()
			expect(() => modeConfigSchema.parse(modeWithDescription)).not.toThrow()
		})

		it("validates file regex patterns", () => {
			const validPatterns = ["\\.md$", ".*\\.txt$", "[a-z]+\\.js$"]
			const invalidPatterns = ["[", "(unclosed", "\\"]

			validPatterns.forEach((pattern) => {
				const mode = {
					slug: "test",
					name: "Test",
					roleDefinition: "Test",
					tools: ["read", ["write", { fileRegex: pattern }]],
				}
				expect(() => modeConfigSchema.parse(mode)).not.toThrow()
			})

			invalidPatterns.forEach((pattern) => {
				const mode = {
					slug: "test",
					name: "Test",
					roleDefinition: "Test",
					tools: ["read", ["write", { fileRegex: pattern }]],
				}
				expect(() => modeConfigSchema.parse(mode)).toThrow()
			})
		})

		it("prevents duplicate tool entries", () => {
			const modeWithDuplicates = {
				slug: "test",
				name: "Test",
				roleDefinition: "Test",
				tools: ["read", "read", ["write", { fileRegex: "\\.md$" }], ["write", { fileRegex: "\\.txt$" }]],
			}

			expect(() => modeConfigSchema.parse(modeWithDuplicates)).toThrow(ZodError)
		})
	})

	const validBaseMode = {
		slug: "123e4567-e89b-12d3-a456-426614174000",
		name: "Test Mode",
		roleDefinition: "Test role definition",
	}

	describe("group format validation", () => {
		test("accepts single group", () => {
			const mode = {
				...validBaseMode,
				tools: ["read"] as const,
			} satisfies ModeConfig

			expect(() => modeConfigSchema.parse(mode)).not.toThrow()
		})

		test("accepts multiple tool groups", () => {
			const mode = {
				...validBaseMode,
				tools: ["read", "write"] as const,
			} satisfies ModeConfig

			expect(() => modeConfigSchema.parse(mode)).not.toThrow()
		})

		test("accepts all available tool groups", () => {
			const mode = {
				...validBaseMode,
				tools: ["read", "write", "execute", "mcp"] as const,
			} satisfies ModeConfig

			expect(() => modeConfigSchema.parse(mode)).not.toThrow()
		})

		test("rejects non-array group format", () => {
			const mode = {
				...validBaseMode,
				tools: "not-an-array" as any,
			}

			expect(() => modeConfigSchema.parse(mode)).toThrow()
		})

		test("rejects invalid group names", () => {
			const mode = {
				...validBaseMode,
				tools: ["invalid_group"] as any,
			}

			expect(() => modeConfigSchema.parse(mode)).toThrow()
		})

		test("rejects duplicate tool entries", () => {
			const mode = {
				...validBaseMode,
				tools: ["read", "read"] as any,
			}

			expect(() => modeConfigSchema.parse(mode)).toThrow(ZodError)
		})

		test("rejects null or undefined tools", () => {
			const modeWithNull = {
				...validBaseMode,
				tools: null as any,
			}

			const modeWithUndefined = {
				...validBaseMode,
				tools: undefined as any,
			}

			expect(() => modeConfigSchema.parse(modeWithNull)).toThrow()
			expect(() => modeConfigSchema.parse(modeWithUndefined)).toThrow()
		})
	})

	describe("canonical tool group validation", () => {
		it("should accept canonical group names as-is", () => {
			const result = modeConfigSchema.parse({
				slug: "test-mode",
				name: "Test Mode",
				roleDefinition: "Test role",
				tools: ["read", "write"],
			})
			expect(result.tools).toEqual(["read", "write"])
		})

		it("should accept browser group with options", () => {
			const result = modeConfigSchema.parse({
				slug: "test-mode",
				name: "Test Mode",
				roleDefinition: "Test role",
				tools: ["read", ["browser", { fileRegex: ".*", description: "test" }]],
			})
			expect(result.tools).toEqual(["read", ["browser", { fileRegex: ".*", description: "test" }]])
		})

		it("should accept browser-only mode", () => {
			const result = modeConfigSchema.parse({
				slug: "test-mode",
				name: "Test Mode",
				roleDefinition: "Test role",
				tools: ["browser"],
			})
			expect(result.tools).toEqual(["browser"])
		})

		it("should reject invalid group names", () => {
			const result = modeConfigSchema.safeParse({
				slug: "test-mode",
				name: "Test Mode",
				roleDefinition: "Test role",
				tools: ["read", "nonexistent"],
			})
			expect(result.success).toBe(false)
		})

		it("should accept valid group names", () => {
			const result = modeConfigSchema.safeParse({
				slug: "test-mode",
				name: "Test Mode",
				roleDefinition: "Test role",
				tools: ["read", "write"],
			})
			expect(result.success).toBe(true)
		})
	})
})
