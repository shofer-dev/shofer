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

import type { PluginUiSender } from "@shofer/types"

import { warnPlugin } from "./plugin-warnings.js"

/**
 * Host seam that delivers a plugin's UI push to its mounted component(s) (design §6.8).
 * Supplied by the extension/CLI where the webview channel lives (core never imports the
 * provider). `post` routes `message` to the `pluginName` plugin's components only.
 */
export interface PluginUiProvider {
	/** Deliver `message` to the named plugin's mounted UI component(s) (scoped by name). */
	post(pluginName: string, message: unknown): void | Promise<void>
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
	}
}
