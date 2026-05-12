import type { GlobalSettings } from "@shofer/shared/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"
import { Button, StandardTooltip } from "@/components/ui"

type AutoApproveToggles = Pick<
	GlobalSettings,
	| "alwaysAllowReadOnly"
	| "alwaysAllowWrite"
	| "alwaysAllowBrowser"
	| "alwaysAllowMcp"
	| "alwaysAllowUncategorized"
	| "alwaysAllowModeSwitch"
	| "alwaysAllowSubtasks"
	| "alwaysAllowExecute"
	| "alwaysAllowFollowupQuestions"
>

export type AutoApproveSetting = keyof AutoApproveToggles

type AutoApproveConfig = {
	key: AutoApproveSetting
	labelKey: string
	descriptionKey: string
	icon: string
	testId: string
	/** The ToolGroup this toggle controls. In the auto-approval popup, toggles
	 *  are filtered to only show groups the current mode has access to. */
	toolGroup: string
	/**
	 * Optional predicate. When it returns true the toggle is disabled in the
	 * UI (greyed out, not clickable). Used for settings whose effect requires
	 * another setting to also be enabled — e.g. `alwaysAllowUncategorized`
	 * is meaningless without `alwaysAllowMcp`.
	 */
	isDisabled?: (props: AutoApproveToggles) => boolean
}

export const autoApproveSettingsConfig: Record<AutoApproveSetting, AutoApproveConfig> = {
	alwaysAllowReadOnly: {
		key: "alwaysAllowReadOnly",
		toolGroup: "read",
		labelKey: "settings:autoApprove.readOnly.label",
		descriptionKey: "settings:autoApprove.readOnly.description",
		icon: "eye",
		testId: "always-allow-readonly-toggle",
	},
	alwaysAllowWrite: {
		key: "alwaysAllowWrite",
		toolGroup: "write",
		labelKey: "settings:autoApprove.write.label",
		descriptionKey: "settings:autoApprove.write.description",
		icon: "edit",
		testId: "always-allow-write-toggle",
	},
	alwaysAllowMcp: {
		key: "alwaysAllowMcp",
		toolGroup: "mcp",
		labelKey: "settings:autoApprove.mcp.label",
		descriptionKey: "settings:autoApprove.mcp.description",
		icon: "plug",
		testId: "always-allow-mcp-toggle",
	},
	alwaysAllowUncategorized: {
		key: "alwaysAllowUncategorized",
		toolGroup: "uncategorized",
		labelKey: "settings:autoApprove.uncategorized.label",
		descriptionKey: "settings:autoApprove.uncategorized.description",
		icon: "question",
		testId: "always-allow-uncategorized-toggle",
		// Only meaningful when the master MCP auto-approval gate is on.
		isDisabled: (props) => !props.alwaysAllowMcp,
	},
	alwaysAllowModeSwitch: {
		key: "alwaysAllowModeSwitch",
		toolGroup: "mode",
		labelKey: "settings:autoApprove.modeSwitch.label",
		descriptionKey: "settings:autoApprove.modeSwitch.description",
		icon: "sync",
		testId: "always-allow-mode-switch-toggle",
	},
	alwaysAllowSubtasks: {
		key: "alwaysAllowSubtasks",
		toolGroup: "subtasks",
		labelKey: "settings:autoApprove.subtasks.label",
		descriptionKey: "settings:autoApprove.subtasks.description",
		icon: "list-tree",
		testId: "always-allow-subtasks-toggle",
	},
	alwaysAllowBrowser: {
		key: "alwaysAllowBrowser",
		toolGroup: "browser",
		labelKey: "settings:autoApprove.browser.label",
		descriptionKey: "settings:autoApprove.browser.description",
		icon: "globe",
		testId: "always-allow-browser-toggle",
	},
	alwaysAllowExecute: {
		key: "alwaysAllowExecute",
		toolGroup: "execute",
		labelKey: "settings:autoApprove.execute.label",
		descriptionKey: "settings:autoApprove.execute.description",
		icon: "terminal",
		testId: "always-allow-execute-toggle",
	},
	alwaysAllowFollowupQuestions: {
		key: "alwaysAllowFollowupQuestions",
		toolGroup: "questions",
		labelKey: "settings:autoApprove.followupQuestions.label",
		descriptionKey: "settings:autoApprove.followupQuestions.description",
		icon: "question",
		testId: "always-allow-followup-questions-toggle",
	},
}

type AutoApproveToggleProps = AutoApproveToggles & {
	onToggle: (key: AutoApproveSetting, value: boolean) => void
}

export const AutoApproveToggle = ({ onToggle, ...props }: AutoApproveToggleProps) => {
	const { t } = useAppTranslation()

	return (
		<div className={cn("flex flex-row flex-wrap gap-2 py-2")}>
			{Object.values(autoApproveSettingsConfig).map(
				({ key, descriptionKey, labelKey, icon, testId, isDisabled }) => {
					const disabled = isDisabled?.(props) ?? false
					return (
						<StandardTooltip key={key} content={t(descriptionKey || "")}>
							<Button
								variant={props[key] ? "primary" : "secondary"}
								onClick={() => onToggle(key, !props[key])}
								aria-label={t(labelKey)}
								aria-pressed={!!props[key]}
								data-testid={testId}
								disabled={disabled}
								className={cn(
									"gap-1.5 text-xs whitespace-nowrap",
									!props[key] && "opacity-50",
									disabled && "opacity-30 cursor-not-allowed",
								)}>
								<span className={`codicon codicon-${icon} text-sm`} />
								<span>{t(labelKey)}</span>
							</Button>
						</StandardTooltip>
					)
				},
			)}
		</div>
	)
}
