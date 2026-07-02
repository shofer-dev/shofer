export { getRulesSection } from "./rules"
export { getSystemInfoSection } from "./system-info"
export { addCustomInstructions } from "./custom-instructions"
export { getModesSection } from "./modes"
export { getSkillsSection } from "./skills"
export { getLiveMemorySection } from "./live-memory"

// Relocated into @shofer/core (Task-cluster A4). Re-exported here so existing
// `./sections` consumers keep importing them unchanged.
export {
	getObjectiveSection,
	getSharedToolUseSection,
	getToolUseGuidelinesSection,
	getCapabilitiesSection,
	markdownFormattingSection,
} from "@shofer/core"
