import { HTMLAttributes, useEffect, useMemo } from "react"
import { Blocks } from "lucide-react"

import type { PluginRequest, PluginView } from "@shofer/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import { ToggleSwitch } from "@src/components/ui"

import { PluginSlot } from "../plugins/PluginSlot"

import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"

function post(plugin: PluginRequest) {
	vscode.postMessage({ type: "plugin", plugin })
}

/** Human-readable one-line summary of a plugin's declarative contributions. */
function contributionSummary(plugin: PluginView, t: (key: string, opts?: Record<string, unknown>) => string): string {
	const c = plugin.contributionCounts
	const parts: string[] = []
	if (c.modes) parts.push(t("settings:plugins.counts.modes", { count: c.modes }))
	if (c.skills) parts.push(t("settings:plugins.counts.skills", { count: c.skills }))
	if (c.commands) parts.push(t("settings:plugins.counts.commands", { count: c.commands }))
	if (c.mcpServers) parts.push(t("settings:plugins.counts.mcpServers", { count: c.mcpServers }))
	if (c.rules) parts.push(t("settings:plugins.counts.rules", { count: c.rules }))
	return parts.join(" · ")
}

export const PluginsSettings = (props: HTMLAttributes<HTMLDivElement>) => {
	const { t } = useAppTranslation()
	const { plugins } = useExtensionState()

	// Ask the extension for the current plugin list whenever this panel mounts.
	useEffect(() => {
		post({ action: "list" })
	}, [])

	const list = useMemo<PluginView[]>(() => plugins?.plugins ?? [], [plugins])

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.plugins")}</SectionHeader>
			<Section>
				<div className="text-vscode-descriptionForeground text-sm mb-3">{t("settings:plugins.description")}</div>

				{list.length === 0 ? (
					<div className="flex flex-col items-center gap-2 text-vscode-descriptionForeground text-sm py-8">
						<Blocks className="size-6 opacity-60" />
						<span>{t("settings:plugins.empty")}</span>
					</div>
				) : (
					<div className="flex flex-col gap-2">
						{list.map((plugin) => {
							const summary = contributionSummary(plugin, t)
							return (
								<div
									key={plugin.name}
									className="flex items-start gap-3 rounded border border-vscode-panel-border p-3">
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2 flex-wrap">
											<span className="font-medium truncate">{plugin.name}</span>
											<span className="text-xs text-vscode-descriptionForeground">
												v{plugin.version}
											</span>
											<span className="text-xs rounded bg-vscode-badge-background text-vscode-badge-foreground px-1.5 py-0.5">
												{t(`settings:plugins.scope.${plugin.scope}`)}
											</span>
										</div>
										{plugin.description && (
											<div className="text-sm text-vscode-descriptionForeground mt-0.5">
												{plugin.description}
											</div>
										)}
										{summary && (
											<div className="text-xs text-vscode-descriptionForeground mt-1">
												{summary}
											</div>
										)}
										{plugin.enabled && plugin.disabledReason && (
											<div className="text-xs text-vscode-errorForeground mt-1">
												{t("settings:plugins.disabledReason", {
													reason: plugin.disabledReason,
												})}
											</div>
										)}
									</div>
									<div className="flex items-center gap-2 shrink-0">
										<span className="text-xs text-vscode-descriptionForeground">
											{plugin.enabled
												? plugin.disabledReason
													? t("settings:plugins.inactive")
													: t("settings:plugins.enabled")
												: t("settings:plugins.disabled")}
										</span>
										<ToggleSwitch
											checked={plugin.enabled}
											onChange={() =>
												post({
													action: "setEnabled",
													name: plugin.name,
													enabled: !plugin.enabled,
												})
											}
											size="medium"
											aria-label={t("settings:plugins.toggleAria", { name: plugin.name })}
										/>
									</div>
								</div>
							)
						})}
					</div>
				)}

				{/* Plugin contributions for the settings tab (design §6.8). Renders
				    nothing when no plugin contributes a settings-tab component. */}
				<PluginSlot region="settings-tab" />
			</Section>
		</div>
	)
}
