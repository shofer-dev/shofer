import { useMemo } from "react"

/**
 * The auto-approval posture as the UI reads it: one flag per BUILTIN category, plus
 * the open `alwaysAllowGroups` record holding one entry per DYNAMIC category.
 *
 * The record has to be excluded from the generic truthiness fold below — an empty
 * object is truthy, so folding it in would report "something is enabled" for every
 * user who has never touched a dynamic category.
 */
interface AutoApprovalToggles {
	alwaysAllowReadOnly?: boolean
	alwaysAllowWrite?: boolean
	alwaysAllowExecute?: boolean
	alwaysAllowMcp?: boolean
	alwaysAllowUncategorized?: boolean
	alwaysAllowModeSwitch?: boolean
	alwaysAllowSubtasks?: boolean
	alwaysAllowFollowupQuestions?: boolean
	alwaysAllowGroups?: Record<string, boolean>
}

export function useAutoApprovalState(toggles: AutoApprovalToggles, autoApprovalEnabled?: boolean) {
	const hasEnabledOptions = useMemo(() => {
		const { alwaysAllowGroups, ...flags } = toggles
		const anyBuiltin = Object.values(flags).some((value) => !!value)
		const anyDynamic = Object.values(alwaysAllowGroups ?? {}).some((value) => value === true)
		return anyBuiltin || anyDynamic
	}, [toggles])

	const effectiveAutoApprovalEnabled = useMemo(() => {
		return autoApprovalEnabled ?? false
	}, [autoApprovalEnabled])

	return {
		hasEnabledOptions,
		effectiveAutoApprovalEnabled,
	}
}
