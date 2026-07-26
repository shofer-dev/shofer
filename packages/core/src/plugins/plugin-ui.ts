/**
 * plugin-ui — the extension→UI push capability handed to a plugin via `ctx.ui`
 * (design §6.8). It is the sender half of the scoped plugin-UI channel: the
 * {@link ShoferPlugin.onUiMessage} hook receives messages *from* a plugin's mounted
 * UI component(s); {@link PluginUiSender.postMessage} pushes messages *to* them.
 *
 * The *delivery* is host-side (it needs the extension's webview / provider — e.g.
 * `ShoferProvider.postPluginUiMessage`), so `@shofer/core` stays host-agnostic by
 * consuming a {@link PluginUiProvider} seam the extension/CLI supplies. Namespacing is
 * enforced by the host sender (every message is tagged with the plugin name), so a
 * plugin can neither observe nor spoof another's channel.
 *
 * Gating (fail-closed, mirroring `ctx.host.search`): no host {@link PluginUiProvider}
 * wired (headless/pure-core) ⇒ `ctx.ui` is absent entirely; wired but the plugin did
 * not grant any `permissions.ui` region ⇒ absent (nothing to render into, so nothing
 * to push to). Pushing to the UI is side-effect-free and unbilled, so — unlike
 * `ctx.ai` — the grant alone gates it (no consent step).
 */

import type { PluginPanelOptions, PluginUiSender } from "@shofer/types"

import { warnPlugin } from "./plugin-warnings.js"

/**
 * Host seam that delivers a plugin's UI push to its mounted component(s) (design §6.8).
 * Supplied by the extension/CLI where the webview channel lives (core never imports the
 * provider). `post` routes `message` to the `pluginName` plugin's components only.
 */
export interface PluginUiProvider {
	/** Deliver `message` to the named plugin's mounted UI component(s) (scoped by name). */
	post(pluginName: string, message: unknown): void | Promise<void>
	/**
	 * Open — or focus — the named plugin's UI bundle in a standalone editor panel (design
	 * §6.8). Optional: a host without a panel surface (headless/pure-core) omits it, in
	 * which case {@link PluginUiSender.showPanel} is a warned no-op.
	 */
	showPanel?(pluginName: string, opts?: PluginPanelOptions): void | Promise<void>
	/**
	 * Reveal Settings → Plugins (where the named plugin's toggle, config form and
	 * AI-consent live). Optional: a host without a settings surface omits it, in which
	 * case {@link PluginUiSender.openSettings} is a warned no-op.
	 */
	openSettings?(pluginName: string): void | Promise<void>
}

/**
 * The live {@link PluginUiSender} for a UI-granted plugin: delegates to the host
 * {@link PluginUiProvider}, tagging every push with the plugin's name. Fire-and-forget
 * (the plugin does not await delivery); a delivery error is swallowed + warned so a
 * detached/closed webview can never break the plugin's hook.
 */
export function createPluginUi(pluginName: string, provider: PluginUiProvider): PluginUiSender {
	return {
		postMessage(message: unknown): void {
			try {
				void Promise.resolve(provider.post(pluginName, message)).catch((error) => {
					warnPlugin(`[plugin:${pluginName}] ctx.ui.postMessage delivery failed: ${String(error)}`)
				})
			} catch (error) {
				warnPlugin(`[plugin:${pluginName}] ctx.ui.postMessage failed: ${String(error)}`)
			}
		},
		showPanel(opts?: PluginPanelOptions): void {
			// Gated by the same `permissions.ui` grant as the rest of `ctx.ui` (this whole
			// sender is only built for a UI-granted plugin). No-op + warn when the host wired
			// no panel surface, so a plugin's call is safe on any host. Fire-and-forget.
			if (!provider.showPanel) {
				warnPlugin(`[plugin:${pluginName}] ctx.ui.showPanel: host has no panel surface (ignored)`)
				return
			}
			try {
				void Promise.resolve(provider.showPanel(pluginName, opts)).catch((error) => {
					warnPlugin(`[plugin:${pluginName}] ctx.ui.showPanel delivery failed: ${String(error)}`)
				})
			} catch (error) {
				warnPlugin(`[plugin:${pluginName}] ctx.ui.showPanel failed: ${String(error)}`)
			}
		},
		openSettings(): void {
			if (!provider.openSettings) {
				warnPlugin(`[plugin:${pluginName}] ctx.ui.openSettings: host has no settings surface (ignored)`)
				return
			}
			try {
				void Promise.resolve(provider.openSettings(pluginName)).catch((error) => {
					warnPlugin(`[plugin:${pluginName}] ctx.ui.openSettings failed: ${String(error)}`)
				})
			} catch (error) {
				warnPlugin(`[plugin:${pluginName}] ctx.ui.openSettings failed: ${String(error)}`)
			}
		},
	}
}
