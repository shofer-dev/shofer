import { useCallback } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui"
import { FormattedTextField, unlimitedDecimalFormatter } from "../common/FormattedTextField"

import { SetCachedStateField } from "./types"
import { SearchableSetting } from "./SearchableSetting"

export type BudgetAction = "pause" | "abort" | "kill"

export interface DefaultCostLimit {
	maxUsd: number
	action: BudgetAction
}

interface DefaultCostLimitSettingProps {
	defaultCostLimit?: DefaultCostLimit
	setCachedStateField: SetCachedStateField<"defaultCostLimit">
}

const DEFAULT_INITIAL_LIMIT_USD = 5
const DEFAULT_INITIAL_ACTION: BudgetAction = "pause"

/**
 * Settings-pane row for the default per-root-task cost limit
 * (`globalSettings.defaultCostLimit`). Seeds the cap on every newly-
 * created root task; existing tasks are unaffected (the cap can be
 * edited live from the TaskHeader pencil affordance).
 *
 * The control collapses to a single checkbox when no default is set;
 * enabling it reveals a $ input + action select. Disabling it clears
 * the persisted default.
 */
export const DefaultCostLimitSetting = ({ defaultCostLimit, setCachedStateField }: DefaultCostLimitSettingProps) => {
	const { t: _t } = useAppTranslation()
	const enabled = !!defaultCostLimit

	const handleToggle = useCallback(
		(checked: boolean) => {
			if (checked) {
				setCachedStateField("defaultCostLimit", {
					maxUsd: DEFAULT_INITIAL_LIMIT_USD,
					action: DEFAULT_INITIAL_ACTION,
				})
			} else {
				setCachedStateField("defaultCostLimit", undefined as unknown as DefaultCostLimit)
			}
		},
		[setCachedStateField],
	)

	const handleMaxUsdChange = useCallback(
		(value: number | undefined) => {
			if (!defaultCostLimit) {
				return
			}
			if (value === undefined || value <= 0) {
				return
			}
			setCachedStateField("defaultCostLimit", { ...defaultCostLimit, maxUsd: value })
		},
		[defaultCostLimit, setCachedStateField],
	)

	const handleActionChange = useCallback(
		(value: string) => {
			if (!defaultCostLimit) {
				return
			}
			setCachedStateField("defaultCostLimit", {
				...defaultCostLimit,
				action: value as BudgetAction,
			})
		},
		[defaultCostLimit, setCachedStateField],
	)

	return (
		<SearchableSetting
			settingId="default-cost-limit"
			section="contextManagement"
			label="Default cost limit for new tasks">
			<VSCodeCheckbox
				checked={enabled}
				onChange={(e: any) => handleToggle(!!e.target.checked)}
				data-testid="default-cost-limit-enabled-checkbox">
				<span className="font-medium">Default cost limit for new tasks</span>
			</VSCodeCheckbox>
			<div className="text-vscode-descriptionForeground text-sm mt-1">
				Cap the cumulative USD spend on every new root task (subtask costs roll into the root). The cap can be
				edited live from the task header. Existing tasks are not affected when this default changes.
			</div>

			{enabled && defaultCostLimit && (
				<div className="flex flex-col gap-3 pl-3 mt-2 border-l-2 border-vscode-button-background">
					<div className="flex items-center gap-2">
						<label className="text-sm font-medium whitespace-nowrap">
							<span className="codicon codicon-credit-card mr-1" />
							Max budget:
						</label>
						<FormattedTextField
							value={defaultCostLimit.maxUsd}
							onValueChange={handleMaxUsdChange}
							formatter={unlimitedDecimalFormatter}
							style={{ maxWidth: "160px" }}
							data-testid="default-cost-limit-max-usd-input"
							leftNodes={[<span key="dollar">$</span>]}
						/>
					</div>
					<div className="flex items-center gap-2">
						<label className="text-sm font-medium whitespace-nowrap">When limit reached:</label>
						<Select value={defaultCostLimit.action} onValueChange={handleActionChange}>
							<SelectTrigger className="w-[220px]" data-testid="default-cost-limit-action-select">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="pause">Pause &amp; ask (increase / abort / continue)</SelectItem>
								<SelectItem value="abort">Abort task cleanly</SelectItem>
								<SelectItem value="kill">Kill task (headless)</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</div>
			)}
		</SearchableSetting>
	)
}
