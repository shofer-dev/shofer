import { HTMLAttributes, forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react"
import { Blocks, ChevronDown, ChevronRight, Lock } from "lucide-react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

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

/** Imperative handle so `SettingsView` can commit/drop staged plugin config on Save/Discard. */
export interface PluginsSettingsRef {
	/** Persist staged config overrides (posts `setConfig` per edited plugin). Called on Save. */
	commitConfigBuffers: () => void
	/** Drop staged config edits. Called on Discard. */
	discardConfigBuffers: () => void
}

type PluginsSettingsProps = HTMLAttributes<HTMLDivElement> & {
	/**
	 * Fired when a plugin config field is edited, so `SettingsView` can enable its Save
	 * button. Config is staged and only persisted when the user clicks that (single) Save.
	 */
	onConfigDirty?: () => void
}

/**
 * Editable config form for one plugin, driven by its manifest `config` JSON-schema
 * (design §5). Controlled by {@link PluginsSettings}: `override` is the full staged/stored
 * override object (a field falls back to its schema `default` when absent). Edits are
 * **staged** — they persist only via the shared Settings Save button, not a local one.
 * Collapsed by default; renders nothing when the plugin has no config.
 */
function PluginConfigForm({
	plugin,
	override,
	onChange,
	onReset,
}: {
	plugin: PluginView
	override: Record<string, unknown>
	onChange: (key: string, value: unknown) => void
	onReset: () => void
}) {
	const { t } = useAppTranslation()
	const props = plugin.configSchema?.properties
	const [open, setOpen] = useState(false)
	// Supplied by a `.shofer/` file layer (an org config bundle, or a hand-written
	// settings.json). That layer WINS over anything stored locally, so every control
	// below is disabled: offering an edit that would be silently shadowed is worse than
	// showing none at all.
	const managed = plugin.configManagedBy === "file-layer"

	if (!props || Object.keys(props).length === 0) return null

	const valueOf = (key: string): unknown => (override[key] !== undefined ? override[key] : props[key]?.default)

	return (
		<div className="mt-2">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				className="flex items-center gap-1 text-xs text-vscode-descriptionForeground hover:text-vscode-foreground">
				{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
				{t("settings:plugins.configure")}
			</button>
			{open && (
				<div className="mt-2 flex flex-col gap-3 pl-3 border-l border-vscode-panel-border">
					{managed && (
						<div className="text-xs text-vscode-descriptionForeground flex items-start gap-1.5">
							<Lock className="size-3.5 shrink-0 mt-0.5" />
							<span>{t("settings:plugins.configManaged")}</span>
						</div>
					)}
					{Object.entries(props).map(([key, spec]) => {
						const val = valueOf(key)
						// A credential the host keeps in its secret store: its value never
						// reaches this webview, so the field shows whether one is stored and
						// takes a replacement. Typing nothing leaves the stored key alone;
						// clearing a staged edit to empty deletes it.
						const isSecret = spec.secret === true
						const secretStored = isSecret && plugin.configSecretsSet?.includes(key)
						const staged = override[key]
						return (
							<div key={key} className="flex flex-col gap-1">
								<div className="flex items-center gap-2">
									<span className="text-xs font-medium">{key}</span>
									{spec.type === "boolean" && (
										<ToggleSwitch
											checked={!!val}
											onChange={() => {
												if (!managed) onChange(key, !val)
											}}
											disabled={managed}
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
								{spec.type !== "boolean" && !isSecret && (
									<VSCodeTextField
										value={val === undefined || val === null ? "" : String(val)}
										readOnly={managed}
										disabled={managed}
										onInput={(e) => {
											if (managed) return
											const raw = (e.target as HTMLInputElement).value
											onChange(
												key,
												spec.type === "number" ? (raw === "" ? undefined : Number(raw)) : raw,
											)
										}}
									/>
								)}
								{isSecret && (
									<>
										<VSCodeTextField
											type="password"
											readOnly={managed}
											disabled={managed}
											value={typeof staged === "string" ? staged : ""}
											placeholder={
												secretStored
													? t("settings:plugins.secretSet")
													: t("settings:plugins.secretUnset")
											}
											onInput={(e) => {
												if (!managed) onChange(key, (e.target as HTMLInputElement).value)
											}}
										/>
										{secretStored && (
											<span className="text-xs text-vscode-descriptionForeground">
												{t("settings:plugins.secretHint")}
											</span>
										)}
									</>
								)}
							</div>
						)
					})}
					{/* Staging affordance (not a Save): clears all overrides back to schema
					    defaults; applied when the shared Settings Save button is clicked.
					    Hidden while the file layer supplies the config — there is no local
					    override to reset, and the layer would win regardless. */}
					<button
						type="button"
						hidden={managed}
						onClick={onReset}
						className="self-start text-xs text-vscode-descriptionForeground hover:text-vscode-foreground underline">
						{t("settings:plugins.resetDefaults")}
					</button>
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

export const PluginsSettings = forwardRef<PluginsSettingsRef, PluginsSettingsProps>(function PluginsSettings(
	{ onConfigDirty, ...props },
	ref,
) {
	const { t } = useAppTranslation()
	const { plugins } = useExtensionState()

	// Staged config overrides, keyed by plugin name. A plugin present here has pending
	// edits (the full override object to persist); absent ⇒ show its persisted config.
	const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({})

	// Save-gated staged toggles (plugin name → staged value). Enable/disable and
	// billed-AI consent are settings VALUES, so they must not apply on change;
	// missing key ⇒ show the live value. Committed with the config drafts on Save.
	const [pendingEnabled, setPendingEnabled] = useState<Record<string, boolean>>({})
	const [pendingAiConsent, setPendingAiConsent] = useState<Record<string, boolean>>({})

	// Ask the extension for the current plugin list whenever this panel mounts.
	useEffect(() => {
		post({ action: "list" })
	}, [])

	const list = useMemo<PluginView[]>(() => plugins?.plugins ?? [], [plugins])

	useImperativeHandle(
		ref,
		() => ({
			commitConfigBuffers: () => {
				for (const [name, config] of Object.entries(drafts)) {
					post({ action: "setConfig", name, config })
				}
				for (const [name, enabled] of Object.entries(pendingEnabled)) {
					const live = list.find((p) => p.name === name)
					if (live && live.enabled !== enabled) {
						post({ action: "setEnabled", name, enabled })
					}
				}
				for (const [name, consented] of Object.entries(pendingAiConsent)) {
					const live = list.find((p) => p.name === name)
					if (live && !!live.aiConsented !== consented) {
						post({ action: "setAiConsent", name, consented })
					}
				}
				setDrafts({})
				setPendingEnabled({})
				setPendingAiConsent({})
			},
			discardConfigBuffers: () => {
				setDrafts({})
				setPendingEnabled({})
				setPendingAiConsent({})
			},
		}),
		[drafts, pendingEnabled, pendingAiConsent, list],
	)

	// Seed a plugin's draft from its persisted config on first edit, then patch the field.
	const editField = (plugin: PluginView, key: string, value: unknown) => {
		setDrafts((d) => {
			const base = d[plugin.name] ?? { ...plugin.config }
			return { ...d, [plugin.name]: { ...base, [key]: value } }
		})
		onConfigDirty?.()
	}
	const resetPlugin = (plugin: PluginView) => {
		setDrafts((d) => ({ ...d, [plugin.name]: {} }))
		onConfigDirty?.()
	}

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.plugins")}</SectionHeader>
			<Section>
				<div className="text-vscode-descriptionForeground text-sm mb-3">
					{t("settings:plugins.description")}
				</div>

				{list.length === 0 ? (
					<div className="flex flex-col items-center gap-2 text-vscode-descriptionForeground text-sm py-8">
						<Blocks className="size-6 opacity-60" />
						<span>{t("settings:plugins.empty")}</span>
					</div>
				) : (
					<div className="flex flex-col gap-2">
						{list.map((plugin) => {
							const summary = contributionSummary(plugin, t)
							// Staged-first so unsaved toggles render.
							const effectiveEnabled = pendingEnabled[plugin.name] ?? plugin.enabled
							const effectiveAiConsented = pendingAiConsent[plugin.name] ?? !!plugin.aiConsented
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
													checked={effectiveAiConsented}
													disabled={!effectiveEnabled}
													onChange={() => {
														setPendingAiConsent((prev) => ({
															...prev,
															[plugin.name]: !effectiveAiConsented,
														}))
														onConfigDirty?.()
													}}
													size="small"
													aria-label={t("settings:plugins.aiConsentAria", {
														name: plugin.name,
													})}
												/>
												<span className="text-xs text-vscode-descriptionForeground">
													{effectiveAiConsented
														? t("settings:plugins.aiConsented")
														: t("settings:plugins.aiNotConsented")}
												</span>
												{!effectiveAiConsented && (
													<div className="w-full text-xs text-vscode-descriptionForeground">
														{t("settings:plugins.aiConsentHint")}
													</div>
												)}
											</div>
										)}
										{/* Editable config form from the plugin's manifest `config`
										    schema. Edits stage into `drafts` and persist via the
										    shared Settings Save button (no local Save button). */}
										<PluginConfigForm
											plugin={plugin}
											override={drafts[plugin.name] ?? plugin.config ?? {}}
											onChange={(key, value) => editField(plugin, key, value)}
											onReset={() => resetPlugin(plugin)}
										/>
									</div>
									<div className="flex items-center gap-2 shrink-0">
										<span className="text-xs text-vscode-descriptionForeground">
											{effectiveEnabled
												? plugin.disabledReason
													? t("settings:plugins.inactive")
													: t("settings:plugins.enabled")
												: t("settings:plugins.disabled")}
										</span>
										<ToggleSwitch
											checked={effectiveEnabled}
											onChange={() => {
												setPendingEnabled((prev) => ({
													...prev,
													[plugin.name]: !effectiveEnabled,
												}))
												onConfigDirty?.()
											}}
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
})
