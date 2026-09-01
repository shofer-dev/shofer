import { useMemo } from "react"
import { useExtensionState } from "@src/context/ExtensionStateContext"

/**
 * Custom hook that creates and returns the auto-approval toggles object
 * This encapsulates the logic for creating the toggles object from extension state
 *
 * It carries both planes of the auto-approval posture: the eight flat `alwaysAllow*`
 * keys of the BUILTIN categories, and `alwaysAllowGroups` — the open record holding one
 * entry per DYNAMIC category (a name absent from it means "ask").
 */
export function useAutoApprovalToggles() {
	const {
		alwaysAllowReadOnly,
		alwaysAllowWrite,
		alwaysAllowExecute,
		alwaysAllowMcp,
		alwaysAllowUncategorized,
		alwaysAllowModeSwitch,
		alwaysAllowSubtasks,
		alwaysAllowFollowupQuestions,
		alwaysAllowGroups,
	} = useExtensionState()

	const toggles = useMemo(
		() => ({
			alwaysAllowReadOnly,
			alwaysAllowWrite,
			alwaysAllowExecute,
			alwaysAllowMcp,
			alwaysAllowUncategorized,
			alwaysAllowModeSwitch,
			alwaysAllowSubtasks,
			alwaysAllowFollowupQuestions,
			alwaysAllowGroups,
		}),
		[
			alwaysAllowReadOnly,
			alwaysAllowWrite,
			alwaysAllowExecute,
			alwaysAllowMcp,
			alwaysAllowUncategorized,
			alwaysAllowModeSwitch,
			alwaysAllowSubtasks,
			alwaysAllowFollowupQuestions,
			alwaysAllowGroups,
		],
	)

	return toggles
}
