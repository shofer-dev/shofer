import { useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"

import { useExtensionState } from "@src/context/ExtensionStateContext"

import { PluginSlot } from "./PluginSlot"

/**
 * Event a plugin's chat-input badge dispatches to reveal + focus its sidebar panel
 * (the plugin-native "View Chat"). `detail.pluginName` targets a specific plugin;
 * omitted reveals any sidebar-panel drawer.
 */
export const REVEAL_PLUGIN_PANEL_EVENT = "shofer:reveal-plugin-panel"

/**
 * Host mount point for plugin `sidebar-panel` UI contributions — a collapsible drawer
 * rendered in the chat view (e.g. the Live Memory plugin's live agent/chat panel).
 *
 * Renders **nothing** when no plugin contributes to the region, so it is byte-for-byte
 * invisible without a sidebar-panel plugin. The inner {@link PluginSlot} loads each
 * contributed component (dynamic import, error-isolated); this wrapper only adds the
 * collapsible chrome + a bounded, scrollable body so a tall panel can't crowd the chat.
 */
export function PluginSidebarPanel() {
	const { pluginUiContributions } = useExtensionState()
	// Collapsed by default so the panel doesn't crowd the chat view — opened on demand
	// (chevron, or the badge popover's "View Chat"), mirroring the built-in's on-demand
	// "View Chat" panel rather than an always-open drawer.
	const [open, setOpen] = useState(false)
	const rootRef = useRef<HTMLDivElement>(null)

	const contributions = (pluginUiContributions?.contributions ?? []).filter((c) => c.region === "sidebar-panel")

	// Reveal + scroll into view when a plugin badge fires the reveal event ("View Chat").
	useEffect(() => {
		const onReveal = (e: Event) => {
			const target = (e as CustomEvent<{ pluginName?: string }>).detail?.pluginName
			if (target && !contributions.some((c) => c.pluginName === target)) return
			setOpen(true)
			requestAnimationFrame(() => rootRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }))
		}
		window.addEventListener(REVEAL_PLUGIN_PANEL_EVENT, onReveal)
		return () => window.removeEventListener(REVEAL_PLUGIN_PANEL_EVENT, onReveal)
	}, [contributions])

	if (contributions.length === 0) return null

	const label = contributions.length === 1 ? contributions[0]!.pluginName : `Plugin panels (${contributions.length})`

	return (
		<div ref={rootRef} className="border-b border-vscode-panel-border shrink-0">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				className="flex items-center gap-1 w-full px-3 py-1.5 text-xs font-medium text-vscode-descriptionForeground hover:text-vscode-foreground">
				{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
				{label}
			</button>
			{open && (
				<div className="max-h-64 overflow-y-auto px-3 pb-2">
					<PluginSlot region="sidebar-panel" />
				</div>
			)}
		</div>
	)
}
