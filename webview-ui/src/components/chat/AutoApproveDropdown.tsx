import React from "react"
import { ListChecks, LayoutList, Settings, CheckCheck, X } from "lucide-react"
import { DEFAULT_MODES } from "@shofer/types"

import { vscode } from "@/utils/vscode"

import { cn } from "@/lib/utils"

import { useExtensionState } from "@/context/ExtensionStateContext"

import { useAppTranslation } from "@/i18n/TranslationContext"

import { useAutoApprovalToggles } from "@/hooks/useAutoApprovalToggles"
import { useAutoApprovalState } from "@/hooks/useAutoApprovalState"

import { useShoferPortal } from "@/components/ui/hooks/useShoferPortal"

import { Popover, PopoverContent, PopoverTrigger, StandardTooltip, ToggleSwitch, Button } from "@/components/ui"

import { AutoApproveSetting, autoApproveSettingsConfig } from "../settings/AutoApproveToggle"

/**
 * Resolve the set of ToolGroup names accessible to the current mode.
 *
 * Mode group entries can be bare strings ("read") or tuples
 * (["write", { fileRegex: "..." }]), or scoped objects
 * ({ read: { allowed: [...], denied: [...] } }).
 * This extracts just the group name from each entry.
 *
 * Derived from the canonical DEFAULT_MODES in @shofer/types rather than
 * a hard-coded copy, so the auto-approval dropdown stays in sync with
 * mode definitions automatically.
 */
function getModeAllowedGroups(
	modeSlug: string | undefined,
	customModes: Array<{ slug: string; groups?: Array<string | [string, unknown]> }> | undefined,
): Set<string> {
	// Build the default-mode group map from the single source of truth.
	const defaultModeGroups: Record<string, string[]> = {}
	for (const m of DEFAULT_MODES) {
		defaultModeGroups[m.slug] = (m.groups ?? []).map((g) =>
			typeof g === "string" ? g : Array.isArray(g) ? g[0] : Object.keys(g)[0]!,
		)
	}

	// Check custom modes first
	if (customModes && modeSlug) {
		const custom = customModes.find((m) => m.slug === modeSlug)
		if (custom?.groups) {
			return new Set(custom.groups.map((g) => (Array.isArray(g) ? g[0] : g)))
		}
	}

	// Fall back to default mode groups.
	// If the slug is unrecognised (e.g. a custom mode without groups in
	// customModes), show all toggles rather than hiding everything.
	const slug = modeSlug ?? "code"
	const defaults = defaultModeGroups[slug]
	if (!defaults) {
		return new Set(Object.values(autoApproveSettingsConfig).map((c) => c.toolGroup))
	}
	return new Set(defaults)
}

interface AutoApproveDropdownProps {
	disabled?: boolean
	triggerClassName?: string
}

export const AutoApproveDropdown = ({ disabled = false, triggerClassName = "" }: AutoApproveDropdownProps) => {
	const [open, setOpen] = React.useState(false)
	const portalContainer = useShoferPortal("shofer-portal")
	const { t } = useAppTranslation()

	const {
		autoApprovalEnabled,
		setAutoApprovalEnabled,
		setAlwaysAllowReadOnly,
		setAlwaysAllowWrite,
		setAlwaysAllowBrowser,
		setAlwaysAllowExecute,
		setAlwaysAllowMcp,
		setAlwaysAllowUncategorized,
		setAlwaysAllowModeSwitch,
		setAlwaysAllowSubtasks,
		setAlwaysAllowFollowupQuestions,
		mode,
		customModes,
	} = useExtensionState()

	const toggles = useAutoApprovalToggles()

	const onAutoApproveToggle = React.useCallback(
		(key: AutoApproveSetting, value: boolean) => {
			vscode.postMessage({ type: "updateSettings", updatedSettings: { [key]: value } })

			switch (key) {
				case "alwaysAllowReadOnly":
					setAlwaysAllowReadOnly(value)
					break
				case "alwaysAllowWrite":
					setAlwaysAllowWrite(value)
					break
				case "alwaysAllowBrowser":
					setAlwaysAllowBrowser(value)
					break
				case "alwaysAllowExecute":
					setAlwaysAllowExecute(value)
					break
				case "alwaysAllowMcp":
					setAlwaysAllowMcp(value)
					break
				case "alwaysAllowUncategorized":
					setAlwaysAllowUncategorized(value)
					break
				case "alwaysAllowModeSwitch":
					setAlwaysAllowModeSwitch(value)
					break
				case "alwaysAllowSubtasks":
					setAlwaysAllowSubtasks(value)
					break
				case "alwaysAllowFollowupQuestions":
					setAlwaysAllowFollowupQuestions(value)
					break
			}

			// If enabling any option, ensure autoApprovalEnabled is true.
			if (value && !autoApprovalEnabled) {
				setAutoApprovalEnabled(true)
				vscode.postMessage({ type: "autoApprovalEnabled", bool: true })
			}
		},
		[
			autoApprovalEnabled,
			setAlwaysAllowReadOnly,
			setAlwaysAllowWrite,
			setAlwaysAllowBrowser,
			setAlwaysAllowExecute,
			setAlwaysAllowMcp,
			setAlwaysAllowUncategorized,
			setAlwaysAllowModeSwitch,
			setAlwaysAllowSubtasks,
			setAlwaysAllowFollowupQuestions,
			setAutoApprovalEnabled,
		],
	)

	// Calculate enabled and total counts as separate properties
	const allSettingsArray = React.useMemo(() => Object.values(autoApproveSettingsConfig), [])

	// Filter to only show toggles for groups accessible in the current mode.
	const allowedGroups = React.useMemo(
		() => getModeAllowedGroups(mode, (customModes as any) ?? []),
		[mode, customModes],
	)
	const settingsArray = React.useMemo(
		() => allSettingsArray.filter((s) => allowedGroups.has(s.toolGroup)),
		[allSettingsArray, allowedGroups],
	)

	const handleSelectAll = React.useCallback(() => {
		// Enable all mode-accessible options
		settingsArray.forEach(({ key }) => {
			onAutoApproveToggle(key, true)
		})
		// Enable master auto-approval
		if (!autoApprovalEnabled) {
			setAutoApprovalEnabled(true)
			vscode.postMessage({ type: "autoApprovalEnabled", bool: true })
		}
	}, [onAutoApproveToggle, autoApprovalEnabled, setAutoApprovalEnabled, settingsArray])

	const handleSelectNone = React.useCallback(() => {
		// Disable all mode-accessible options
		settingsArray.forEach(({ key }) => {
			onAutoApproveToggle(key, false)
		})
	}, [onAutoApproveToggle, settingsArray])

	const handleOpenSettings = React.useCallback(
		() =>
			window.postMessage({ type: "action", action: "settingsButtonClicked", values: { section: "autoApprove" } }),
		[],
	)

	// Handle the main auto-approval toggle
	const handleAutoApprovalToggle = React.useCallback(() => {
		const newValue = !(autoApprovalEnabled ?? false)
		setAutoApprovalEnabled(newValue)
		vscode.postMessage({ type: "autoApprovalEnabled", bool: newValue })
	}, [autoApprovalEnabled, setAutoApprovalEnabled])

	const enabledCount = React.useMemo(() => {
		// Count only toggles whose tool group is reachable in the current mode,
		// matching the buttons actually rendered in the dropdown. Otherwise the
		// trigger badge can show a stale "N auto-approved" that includes toggles
		// the active mode cannot exercise (e.g. MCP enabled while in a mode that
		// excludes the `mcp` group).
		return settingsArray.filter(({ key }) => !!toggles[key]).length
	}, [toggles, settingsArray])

	const totalCount = React.useMemo(() => {
		return settingsArray.length
	}, [settingsArray])

	const { effectiveAutoApprovalEnabled } = useAutoApprovalState(toggles, autoApprovalEnabled)

	const tooltipText =
		!effectiveAutoApprovalEnabled || enabledCount === 0
			? t("chat:autoApprove.tooltipManage")
			: t("chat:autoApprove.tooltipStatus", {
					toggles: settingsArray
						.filter((setting) => toggles[setting.key])
						.map((setting) => t(setting.labelKey))
						.join(", "),
				})

	return (
		<Popover open={open} onOpenChange={setOpen} data-testid="auto-approve-dropdown-root">
			<StandardTooltip content={tooltipText}>
				<PopoverTrigger
					disabled={disabled}
					data-testid="auto-approve-dropdown-trigger"
					className={cn(
						"inline-flex items-center gap-1.5 relative whitespace-nowrap px-1.5 py-1 text-xs",
						"bg-transparent border border-[rgba(255,255,255,0.08)] rounded-md text-vscode-foreground",
						"transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset",
						"max-[300px]:shrink-0",
						disabled
							? "opacity-50 cursor-not-allowed"
							: "opacity-90 hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.15)] cursor-pointer",
						triggerClassName,
					)}>
					{!effectiveAutoApprovalEnabled ? (
						<X className="size-3 flex-shrink-0" />
					) : (
						<CheckCheck className="size-3 flex-shrink-0" />
					)}

					<span className="hidden min-[300px]:inline truncate min-w-0">
						{!effectiveAutoApprovalEnabled
							? t("chat:autoApprove.triggerLabelOff")
							: enabledCount === totalCount
								? t("chat:autoApprove.triggerLabelAll")
								: t("chat:autoApprove.triggerLabel", { count: enabledCount })}
					</span>
					<span className="inline min-[300px]:hidden min-w-0">
						{!effectiveAutoApprovalEnabled
							? t("chat:autoApprove.triggerLabelOffShort")
							: enabledCount === totalCount
								? t("chat:autoApprove.triggerLabelAll")
								: enabledCount}
					</span>
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				align="start"
				sideOffset={4}
				container={portalContainer}
				className="p-0 overflow-hidden w-[min(440px,calc(100vw-2rem))]"
				onOpenAutoFocus={(e) => e.preventDefault()}>
				<div className="flex flex-col w-full">
					{/* Header with description */}
					<div className="p-3 border-b border-vscode-dropdown-border">
						<div className="flex items-center justify-between gap-1 pr-1 pb-2">
							<h4 className="m-0 font-bold text-base text-vscode-foreground">
								{t("chat:autoApprove.title")}
							</h4>
							<Settings
								className="inline mb-0.5 mr-1 size-4 cursor-pointer"
								onClick={handleOpenSettings}
							/>
						</div>
						<p className="m-0 text-xs text-vscode-descriptionForeground">
							{t("chat:autoApprove.description")}
						</p>
					</div>
					<div className="grid grid-cols-1 min-[340px]:grid-cols-2 gap-x-2 gap-y-2 p-3">
						{settingsArray.map(({ key, labelKey, descriptionKey, icon, isDisabled }) => {
							const isEnabled = toggles[key]
							const dependencyDisabled = isDisabled?.(toggles) ?? false
							const buttonDisabled = !effectiveAutoApprovalEnabled || dependencyDisabled
							return (
								<StandardTooltip key={key} content={t(descriptionKey)}>
									<Button
										variant={isEnabled ? "primary" : "secondary"}
										onClick={() => onAutoApproveToggle(key, !isEnabled)}
										className={cn(
											"flex items-center gap-2 px-2 py-2 text-sm text-left justify-start h-auto",
											"transition-all duration-150",
											!effectiveAutoApprovalEnabled &&
												"opacity-50 cursor-not-allowed hover:opacity-50",
											dependencyDisabled && "opacity-30 cursor-not-allowed hover:opacity-30",
											!isEnabled && "bg-vscode-button-background/15",
										)}
										disabled={buttonDisabled}
										data-testid={`auto-approve-${key}`}>
										<span className={`codicon codicon-${icon} text-sm flex-shrink-0`} />
										<span className="flex-1 truncate">{t(labelKey)}</span>
									</Button>
								</StandardTooltip>
							)
						})}
					</div>

					{/* Bottom bar with Select All/None buttons */}
					<div className="flex flex-row items-center justify-between px-2 py-2 border-t border-vscode-dropdown-border">
						<div className="flex flex-row gap-1">
							<Button
								variant="ghost"
								size="sm"
								aria-label={t("chat:autoApprove.selectAll")}
								onClick={handleSelectAll}
								disabled={!effectiveAutoApprovalEnabled}
								className={cn(
									"gap-1 px-2 py-1 text-base font-bold h-auto",
									!effectiveAutoApprovalEnabled && "opacity-50 hover:opacity-50 cursor-not-allowed",
								)}>
								<ListChecks className="w-3.5 h-3.5" />
								<span>{t("chat:autoApprove.all")}</span>
							</Button>
							<Button
								variant="ghost"
								size="sm"
								aria-label={t("chat:autoApprove.selectNone")}
								onClick={handleSelectNone}
								disabled={!effectiveAutoApprovalEnabled}
								className={cn(
									"gap-1 px-2 py-1 text-base font-bold h-auto",
									!effectiveAutoApprovalEnabled && "opacity-50 hover:opacity-50 cursor-not-allowed",
								)}>
								<LayoutList className="w-3.5 h-3.5" />
								<span>{t("chat:autoApprove.none")}</span>
							</Button>
						</div>

						<label
							className="flex items-center gap-2 pr-2 cursor-pointer"
							onClick={(e) => {
								// Prevent label click when clicking on the toggle switch itself
								if ((e.target as HTMLElement).closest('[role="switch"]')) {
									e.preventDefault()
									return
								}
								handleAutoApprovalToggle()
							}}>
							<ToggleSwitch
								checked={effectiveAutoApprovalEnabled}
								aria-label="Toggle auto-approval"
								onChange={handleAutoApprovalToggle}
							/>
							<span className={cn("text-sm font-bold select-none")}>Enabled</span>
						</label>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
