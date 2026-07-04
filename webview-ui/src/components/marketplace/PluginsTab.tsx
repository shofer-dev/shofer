import { useEffect, useMemo, useState } from "react"
import { Blocks, Trash2, Upload } from "lucide-react"

import type { PluginRequest, PluginView } from "@shofer/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"
import { Button } from "@/components/ui/button"
import { ToggleSwitch } from "@/components/ui"

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

/**
 * Marketplace "Plugins" tab (design §9, §12; Phase 5.3). Lists installed/discovered
 * plugins with enable/disable + uninstall, and an "Install from file" affordance for a
 * local `.shofer-plugin` archive. Remote/registry install is deferred (design §14 Q5) —
 * install here is LOCAL only; the extension opens a native file picker.
 *
 * Reuses the Phase-1 plugins snapshot pushed to `useExtensionState().plugins` and the
 * `plugin` webview→extension channel (enable/disable/uninstall/install-from-file).
 */
export function PluginsTab() {
	const { t } = useAppTranslation()
	const { plugins } = useExtensionState()
	// Per-plugin two-step uninstall confirmation (avoids a modal dependency).
	const [confirming, setConfirming] = useState<string | null>(null)

	// Ask the extension for the current plugin list whenever this tab mounts.
	useEffect(() => {
		post({ action: "list" })
	}, [])

	const list = useMemo<PluginView[]>(() => plugins?.plugins ?? [], [plugins])

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-start justify-between gap-3">
				<div className="text-vscode-descriptionForeground text-sm flex-1">
					{t("marketplace:plugins.description")}
				</div>
				<Button variant="secondary" className="shrink-0" onClick={() => post({ action: "installFromFile" })}>
					<Upload className="size-4" />
					{t("marketplace:plugins.installFromFile")}
				</Button>
			</div>

			{list.length === 0 ? (
				<div className="flex flex-col items-center gap-2 text-vscode-descriptionForeground text-sm py-10">
					<Blocks className="size-6 opacity-60" />
					<span>{t("marketplace:plugins.empty")}</span>
				</div>
			) : (
				<div className="flex flex-col gap-2">
					{list.map((plugin) => {
						const summary = contributionSummary(plugin, t)
						const isConfirming = confirming === plugin.name
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
										<div className="text-xs text-vscode-descriptionForeground mt-1">{summary}</div>
									)}
									{plugin.enabled && plugin.disabledReason && (
										<div className="text-xs text-vscode-errorForeground mt-1">
											{t("settings:plugins.disabledReason", { reason: plugin.disabledReason })}
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
									{isConfirming ? (
										<div className="flex items-center gap-1">
											<Button
												variant="destructive"
												size="sm"
												onClick={() => {
													post({ action: "uninstall", name: plugin.name })
													setConfirming(null)
												}}>
												{t("marketplace:plugins.uninstall")}
											</Button>
											<Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
												{t("marketplace:plugins.cancel")}
											</Button>
										</div>
									) : (
										<Button
											variant="ghost"
											size="icon"
											aria-label={t("marketplace:plugins.uninstall")}
											title={t("marketplace:plugins.uninstall")}
											onClick={() => setConfirming(plugin.name)}>
											<Trash2 className="size-4" />
										</Button>
									)}
								</div>
							</div>
						)
					})}
				</div>
			)}
		</div>
	)
}
