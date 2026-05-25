import type { ModeConfig, CustomModePrompts } from "@shofer/types"

import { addCustomInstructions } from "../prompts/sections/custom-instructions"
import { getModeBySlug, modes } from "../../shared/modes"

/**
 * Resolve a mode's full prompt-time details (role definition, when-to-use,
 * description, and combined custom instructions).
 *
 * This is host-only because `addCustomInstructions` transitively imports
 * `fs/promises`, `path`, and `os` (via `custom-instructions.ts`), which the
 * webview bundler cannot resolve. It therefore lives under `src/core/modes/`
 * rather than `src/shared/modes.ts`. See the "Shared Module Isolation Rule"
 * in AGENTS.md.
 */
export async function getFullModeDetails(
	modeSlug: string,
	customModes?: ModeConfig[],
	customModePrompts?: CustomModePrompts,
	options?: {
		cwd?: string
		globalCustomInstructions?: string
		language?: string
	},
): Promise<ModeConfig> {
	// First get the base mode config from custom modes or built-in modes
	const baseMode = getModeBySlug(modeSlug, customModes) || modes.find((m) => m.slug === modeSlug) || modes[0]

	// Check for any prompt component overrides
	const promptComponent = customModePrompts?.[modeSlug]

	// Get the base custom instructions
	const baseCustomInstructions = promptComponent?.customInstructions || baseMode.customInstructions || ""
	const baseWhenToUse = promptComponent?.whenToUse || baseMode.whenToUse || ""
	const baseDescription = promptComponent?.description || baseMode.description || ""

	// If we have cwd, load and combine all custom instructions
	let fullCustomInstructions = baseCustomInstructions
	if (options?.cwd) {
		fullCustomInstructions = await addCustomInstructions(
			baseCustomInstructions,
			options.globalCustomInstructions || "",
			options.cwd,
			modeSlug,
			{ language: options.language },
		)
	}

	// Return mode with any overrides applied
	return {
		...baseMode,
		roleDefinition: promptComponent?.roleDefinition || baseMode.roleDefinition,
		whenToUse: baseWhenToUse,
		description: baseDescription,
		customInstructions: fullCustomInstructions,
	}
}
