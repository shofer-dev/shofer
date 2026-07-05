import { HTMLAttributes, useEffect, useMemo, useState } from "react"
import { Blocks, ChevronDown, ChevronRight } from "lucide-react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { PluginRequest, PluginView } from "@shofer/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import { ToggleSwitch, Button } from "@src/components/ui"

import { PluginSlot } from "../plugins/PluginSlot"

import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"

function post(plugin: PluginRequest) {
	vscode.postMessage({ type: "plugin", plugin })
}

/**
 * Editable config form for one plugin, driven by its manifest `config` JSON-schema
 * (design §5). A field's current value is the user's stored override, or the schema
 * default when unset. Saving persists the overrides and reloads the plugin so the new
 * values take effect. Collapsed by default; renders nothing when the plugin has no config.
 */
function PluginConfigForm({ plugin }: { plugin: PluginView }) {
	const { t } = useAppTranslation()
	const props = plugin.configSchema?.properties
	const [open, setOpen] = useState(false)
	const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...plugin.config }))

	// Re-seed the draft when the persisted config changes (e.g. after a save round-trips).
	useEffect(() => {
		setDraft({ ...plugin.config })
	}, [plugin.config])

	if (!props || Object.keys(props).length === 0) return null

	const valueOf = (key: string): unknown => (draft[key] !== undefined ? draft[key] : props[key]?.default)
	const setField = (key: string, v: unknown) => setDraft((d) => ({ ...d, [key]: v }))

	return (
		<div className="mt-2">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex items-center gap-1 text-xs text-vscode-descriptionForeground hover:text-vscode-foreground">
				{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
				{t("settings:plugins.configure")}
			</button>
			{open && (
				<div className="mt-2 flex flex-col gap-3 pl-3 border-l border-vscode-panel-border">
					{Object.entries(props).map(([key, spec]) => {
						const val = valueOf(key)
						return (
							<div key={key} className="flex flex-col gap-1">
								<div className="flex items-center gap-2">
									<span className="text-xs font-medium">{key}</span>
									{spec.type === "boolean" && (
										<ToggleSwitch
											checked={!!val}
											onChange={() => setField(key, !val)}
											size="small"
											aria-label={key}
										/>
									)}
								</div>
								{spec.description && (
									<span className="text-xs text-vscode-descriptionForeground">
										{spec.description}
									</span>
								)}
								{spec.type !== "boolean" && (
									<VSCodeTextField
										value={val === undefined || val === null ? "" : String(val)}
										onInput={(e) => {
											const raw = (e.target as HTMLInputElement).value
											setField(
												key,
												spec.type === "number"
													? raw === ""
														? undefined
														: Number(raw)
													: raw,
											)
										}}
									/>
								)}
							</div>
						)
					})}
					<div className="flex gap-2 mt-1">
						<Button
							onClick={() => post({ action: "setConfig", name: plugin.name, config: draft })}>
							{t("settings:plugins.save")}
						</Button>
						<Button
							variant="secondary"
							onClick={() => {
								setDraft({})
								post({ action: "setConfig", name: plugin.name, config: {} })
							}}>
							{t("settings:plugins.resetDefaults")}
						</Button>
					</div>
				</div>
			)}
		</div>
	)
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
										{/* Billed-AI consent (design §8). A plugin declaring
										    `permissions.ai` needs explicit consent before `ctx.ai`
										    (and any tool that depends on it, e.g. Live Memory's
										    `ask_live_memory`) becomes live. Only actionable while
										    the plugin is enabled. */}
										{plugin.usesAi && (
											<div className="flex items-center gap-2 mt-2 flex-wrap">
												<span className="text-xs rounded bg-vscode-badge-background text-vscode-badge-foreground px-1.5 py-0.5">
													{t("settings:plugins.usesAi")}
												</span>
												<ToggleSwitch
													checked={!!plugin.aiConsented}
													disabled={!plugin.enabled}
													onChange={() =>
														post({
															action: "setAiConsent",
															name: plugin.name,
															consented: !plugin.aiConsented,
														})
													}
													size="small"
													aria-label={t("settings:plugins.aiConsentAria", {
														name: plugin.name,
													})}
												/>
												<span className="text-xs text-vscode-descriptionForeground">
													{plugin.aiConsented
														? t("settings:plugins.aiConsented")
														: t("settings:plugins.aiNotConsented")}
												</span>
												{!plugin.aiConsented && (
													<div className="w-full text-xs text-vscode-descriptionForeground">
														{t("settings:plugins.aiConsentHint")}
													</div>
												)}
											</div>
										)}
										{/* Editable config form from the plugin's manifest `config`
										    schema — the plugin-era replacement for a bespoke tab. */}
										<PluginConfigForm plugin={plugin} />
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
