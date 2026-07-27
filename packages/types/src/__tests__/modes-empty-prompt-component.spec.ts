/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures cast partial prompt objects */
import type { ModeConfig, PromptComponent } from "../mode.js"

import { getModeSelection } from "../modes.js"

/**
 * `customModePrompts` overrides reshape modes the user did **not** author — which,
 * since the six built-ins moved into the `builtin-modes` plugin, means every
 * plugin-contributed mode. A mode the user wrote is used exactly as written.
 */

const architectMode: ModeConfig = {
	slug: "architect",
	name: "🏗️ Architect",
	roleDefinition: "You are Shofer, an experienced technical leader.",
	customInstructions: "Do some information gathering to get more context about the task.",
	tools: ["read"],
	source: "plugin",
	pluginName: "builtin-modes",
}

const debugMode: ModeConfig = {
	slug: "debug",
	name: "🪲 Debug",
	roleDefinition: "You are Shofer, an expert software debugger.",
	customInstructions: "Reflect on 5-7 different possible sources of the problem.",
	tools: ["read"],
	source: "plugin",
	pluginName: "builtin-modes",
}

// `code` first, so it is also the fallback target for an unknown slug.
const allModes: ModeConfig[] = [
	{ ...architectMode, slug: "code", name: "💻 Code", roleDefinition: "Code role", customInstructions: "Code CI" },
	architectMode,
	debugMode,
]

describe("getModeSelection with empty promptComponent", () => {
	it("uses the mode's own instructions when promptComponent is undefined", () => {
		const result = getModeSelection("architect", undefined, allModes)

		expect(result.roleDefinition).toBe(architectMode.roleDefinition)
		expect(result.baseInstructions).toBe(architectMode.customInstructions)
	})

	it("uses the mode's own instructions when promptComponent is null", () => {
		const result = getModeSelection("debug", null as any, allModes)

		expect(result.roleDefinition).toBe(debugMode.roleDefinition)
		expect(result.baseInstructions).toBe(debugMode.customInstructions)
	})

	it("uses promptComponent when it has actual content", () => {
		const validPromptComponent: PromptComponent = {
			roleDefinition: "Custom role",
			customInstructions: "Custom instructions",
		}
		const result = getModeSelection("architect", validPromptComponent, allModes)

		expect(result.roleDefinition).toBe("Custom role")
		expect(result.baseInstructions).toBe("Custom instructions")
	})

	it("merges a partial promptComponent over the mode (instructions only)", () => {
		const partialPromptComponent: PromptComponent = {
			customInstructions: "Only custom instructions",
		}
		const result = getModeSelection("architect", partialPromptComponent, allModes)

		expect(result.roleDefinition).toBe(architectMode.roleDefinition)
		expect(result.baseInstructions).toBe("Only custom instructions")
	})

	it("merges a partial promptComponent over the mode (role only)", () => {
		const partialPromptComponent: PromptComponent = {
			roleDefinition: "Custom debug role",
		}
		const result = getModeSelection("debug", partialPromptComponent, allModes)

		expect(result.roleDefinition).toBe("Custom debug role")
		expect(result.baseInstructions).toBe(debugMode.customInstructions)
	})

	it("handles a promptComponent with both fields", () => {
		const fullPromptComponent: PromptComponent = {
			roleDefinition: "Full custom role",
			customInstructions: "Full custom instructions",
		}
		const result = getModeSelection("architect", fullPromptComponent, allModes)

		expect(result.roleDefinition).toBe("Full custom role")
		expect(result.baseInstructions).toBe("Full custom instructions")
	})

	it("falls back to the default mode when the slug names no mode", () => {
		const partialPromptComponent: PromptComponent = {
			customInstructions: "Custom instructions for unknown mode",
		}
		const result = getModeSelection("non-existent-mode", partialPromptComponent, allModes)

		expect(result.roleDefinition).toBe("Code role")
		expect(result.baseInstructions).toBe("Custom instructions for unknown mode")
	})

	it("takes a user-authored mode exactly as written, ignoring promptComponent", () => {
		const authored: ModeConfig = {
			slug: "mine",
			name: "Mine",
			roleDefinition: "Authored role",
			customInstructions: "Authored instructions",
			tools: ["read"],
			source: "project",
		}
		const result = getModeSelection("mine", { roleDefinition: "override" }, [...allModes, authored])

		expect(result.roleDefinition).toBe("Authored role")
		expect(result.baseInstructions).toBe("Authored instructions")
	})
})
