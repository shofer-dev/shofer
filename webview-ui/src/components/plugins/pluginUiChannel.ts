import type { ExtensionMessage } from "@shofer/types"

import { vscode } from "@src/utils/vscode"

/**
 * The scoped plugin-UI ↔ plugin-extension message channel (design §6.8, Phase 4).
 *
 * Every message is namespaced by `pluginName`, so a plugin's UI can only talk to its
 * own extension-side plugin and can only receive messages addressed to it — one
 * plugin can neither spoof nor observe another's channel. This module is the webview
 * end of that channel: {@link postPluginUiMessage} sends UI → extension, and
 * {@link subscribePluginUiMessages} receives extension → UI (filtered by plugin name).
 *
 * Framework-free (no React) so the transport is unit-testable in isolation; the
 * `PluginSlot` React layer wraps these into a per-mount {@link PluginUIApi}.
 */

/** Send a message from a plugin's UI to its extension-side plugin (scoped by name). */
export function postPluginUiMessage(pluginName: string, message: unknown): void {
	vscode.postMessage({ type: "pluginUiMessage", pluginUiMessage: { pluginName, message } })
}

/**
 * Subscribe to extension → UI messages addressed to `pluginName`. The listener only
 * ever fires for this plugin's messages (namespacing). Returns an unsubscribe fn that
 * removes the underlying `window` "message" listener.
 */
export function subscribePluginUiMessages(pluginName: string, listener: (message: unknown) => void): () => void {
	const handler = (event: MessageEvent) => {
		const data = event.data as ExtensionMessage | undefined
		if (data?.type === "pluginUiMessage" && data.pluginUiMessage?.pluginName === pluginName) {
			listener(data.pluginUiMessage.message)
		}
	}
	window.addEventListener("message", handler)
	return () => window.removeEventListener("message", handler)
}
