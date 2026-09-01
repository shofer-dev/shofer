import type { GlobalSettings } from "@shofer/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"
import { Button, StandardTooltip } from "@/components/ui"

type AutoApproveToggles = Pick<
	GlobalSettings,
	| "alwaysAllowReadOnly"
	| "alwaysAllowWrite"
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

/**
 * The BUILTIN toggles, one per reserved category. There are exactly eight, and this
 * record is hand-written on purpose: each builtin has its own flat `alwaysAllow*`
 * settings key, its own icon and its own copy.
 *
 * A DYNAMIC category has none of that — it is minted at runtime from a name nobody
 * hardcoded — so it is rendered by {@link AutoApproveDynamicToggles} from the
 * `dynamicToolGroups` snapshot instead, against generic templated labels.
 */
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

/** Stable test id for a dynamic category's toggle button. */
export const dynamicToggleTestId = (name: string) => `always-allow-group-${name}-toggle`

type AutoApproveDynamicTogglesProps = {
	/** Registered dynamic category names — the `dynamicToolGroups` state snapshot. */
	names: readonly string[]
	/**
	 * The effective per-category map. A name ABSENT from it means "ask", which is the
	 * same fail-closed posture an unconfigured category has always had.
	 */
	alwaysAllowGroups?: Record<string, boolean>
	onToggle: (name: string, value: boolean) => void
	/** Renders every row non-interactive (e.g. the master auto-approval gate is off). */
	disabled?: boolean
}

/**
 * One toggle per DYNAMIC category, rendered from data rather than from a config
 * record.
 *
 * Labels come from a single templated i18n pair interpolated with the category name,
 * because a category is created on demand — there is no key to add when an MCP server
 * declares `salesforce`, and hand-keying one per category would make the i18n files
 * the thing that decides which categories can be shown.
 */
export const AutoApproveDynamicToggles = ({
	names,
	alwaysAllowGroups,
	onToggle,
	disabled = false,
}: AutoApproveDynamicTogglesProps) => {
	const { t } = useAppTranslation()

	return (
		<div className={cn("flex flex-row flex-wrap gap-2 py-2")}>
			{names.map((name) => {
				const enabled = alwaysAllowGroups?.[name] === true
				return (
					<StandardTooltip key={name} content={t("settings:autoApprove.dynamic.description", { name })}>
						<Button
							variant={enabled ? "primary" : "secondary"}
							onClick={() => onToggle(name, !enabled)}
							aria-label={t("settings:autoApprove.dynamic.label", { name })}
							aria-pressed={enabled}
							data-testid={dynamicToggleTestId(name)}
							disabled={disabled}
							className={cn(
								"gap-1.5 text-xs whitespace-nowrap",
								!enabled && "opacity-50",
								disabled && "opacity-30 cursor-not-allowed",
							)}>
							<span className="codicon codicon-tag text-sm" />
							<span>{t("settings:autoApprove.dynamic.label", { name })}</span>
						</Button>
					</StandardTooltip>
				)
			})}
		</div>
	)
}
