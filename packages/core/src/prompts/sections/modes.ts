import { getHost } from "@shofer/types"
import type { ModeConfig } from "@shofer/types"
import { getAllModes } from "@shofer/types"

// Host-only helper: merges built-in + custom modes with their per-mode prompt
// overrides read through the host `state` capability. The VS Code host reads
// them from `globalState`; a headless host returns no overrides.
async function getAllModesWithPrompts(): Promise<ModeConfig[]> {
	const { customModes = [], customModePrompts = {} } = await getHost().state.readModeOverrides()

	const allModes = getAllModes(customModes)
	return allModes.map((mode) => ({
		...mode,
		roleDefinition: customModePrompts[mode.slug]?.roleDefinition ?? mode.roleDefinition,
		whenToUse: customModePrompts[mode.slug]?.whenToUse ?? mode.whenToUse,
		customInstructions: customModePrompts[mode.slug]?.customInstructions ?? mode.customInstructions,
		// description is not overridable via customModePrompts, so we keep the original
	}))
}

export async function getModesSection(): Promise<string> {
	// Get all modes with their overrides from extension state
	const allModes = await getAllModesWithPrompts()

	const modesContent = `====

MODES

- These are the currently available modes:
${allModes
	.map((mode: ModeConfig) => {
		let description: string
		if (mode.whenToUse && mode.whenToUse.trim() !== "") {
			// Use whenToUse as the primary description, indenting subsequent lines for readability
			description = mode.whenToUse.replace(/\n/g, "\n    ")
		} else {
			// Fallback to the first sentence of roleDefinition if whenToUse is not available
			description = mode.roleDefinition.split(".")[0]!
		}
		return `  * "${mode.name}" mode (${mode.slug}) - ${description}`
	})
	.join("\n")}`

	return modesContent
}
