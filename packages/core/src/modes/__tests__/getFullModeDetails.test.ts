// npx vitest run modes/__tests__/getFullModeDetails.test.ts

import type { ModeConfig } from "@shofer/types"
import { BUILTIN_MODES } from "../../__fixtures__/builtin-modes.js"

// `addCustomInstructions` is an intra-core sibling reached via a RELATIVE import;
// only a relative mock (not the `@shofer/core` barrel) can intercept that call.
vi.mock("../../prompts/sections/custom-instructions.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../prompts/sections/custom-instructions.js")>()),
	addCustomInstructions: vi.fn().mockResolvedValue("Combined instructions"),
}))

import { getFullModeDetails } from "../getFullModeDetails.js"
import { addCustomInstructions } from "../../prompts/sections/custom-instructions.js"

describe("getFullModeDetails", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(addCustomInstructions).mockResolvedValue("Combined instructions")
	})

	it("returns base mode when no overrides exist", async () => {
		const result = await getFullModeDetails("debug", BUILTIN_MODES)
		expect(result).toMatchObject({
			slug: "debug",
			name: "🪲 Debug",
			roleDefinition:
				"You are Shofer, an expert software debugger specializing in systematic problem diagnosis and resolution.",
		})
	})

	it("applies custom mode overrides", async () => {
		const customModes: ModeConfig[] = [
			{
				slug: "debug",
				name: "Custom Debug",
				roleDefinition: "Custom debug role",
				tools: ["read"],
			},
		]

		const result = await getFullModeDetails("debug", [...customModes, ...BUILTIN_MODES])
		expect(result).toMatchObject({
			slug: "debug",
			name: "Custom Debug",
			roleDefinition: "Custom debug role",
			tools: ["read"],
		})
	})

	it("applies prompt component overrides", async () => {
		const customModePrompts = {
			debug: {
				roleDefinition: "Overridden role",
				customInstructions: "Overridden instructions",
			},
		}

		const result = await getFullModeDetails("debug", BUILTIN_MODES, customModePrompts)
		expect(result.roleDefinition).toBe("Overridden role")
		expect(result.customInstructions).toBe("Overridden instructions")
	})

	it("combines custom instructions when cwd provided", async () => {
		const options = {
			cwd: "/test/path",
			globalCustomInstructions: "Global instructions",
			language: "en",
		}

		await getFullModeDetails("debug", BUILTIN_MODES, undefined, options)

		expect(addCustomInstructions).toHaveBeenCalledWith(
			expect.any(String),
			"Global instructions",
			"/test/path",
			"debug",
			{ language: "en" },
		)
	})

	it("falls back to the default mode for a slug nothing defines", async () => {
		const result = await getFullModeDetails("non-existent", BUILTIN_MODES)
		expect(result).toMatchObject({ ...BUILTIN_MODES[0] })
	})
})
