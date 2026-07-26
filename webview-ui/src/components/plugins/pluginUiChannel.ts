import { isPluginUiResponse, type ExtensionMessage } from "@shofer/types"

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
			// Responses are the transport's own traffic, not the plugin's — delivering
			// them to `onMessage` subscribers too would make every plugin filter them out.
			if (isPluginUiResponse(data.pluginUiMessage.message)) return
			listener(data.pluginUiMessage.message)
		}
	}
	window.addEventListener("message", handler)
	return () => window.removeEventListener("message", handler)
}

/** Monotonic per-webview correlation ids for {@link requestPluginUi}. */
let nextRequestId = 0

/**
 * Call a plugin's `handleRequest` and await its result, over the same scoped channel
 * as {@link postPluginUiMessage}. The host routes it to the plugin instance on the
 * focused task's own host (local or a remote executor).
 *
 * Rejects on a plugin/routing error. Deliberately has **no timeout**: a plugin doing
 * real work (computing a diff over a large workspace) can legitimately take a while,
 * and a spurious timeout here would surface as "the feature is broken" rather than
 * "it is still working".
 */
export function requestPluginUi(
	pluginName: string,
	method: string,
	params?: unknown,
	opts?: { mutates?: boolean },
): Promise<unknown> {
	const id = `${pluginName}:${nextRequestId++}`
	return new Promise((resolve, reject) => {
		const handler = (event: MessageEvent) => {
			const data = event.data as ExtensionMessage | undefined
			if (data?.type !== "pluginUiMessage" || data.pluginUiMessage?.pluginName !== pluginName) return
			const message = data.pluginUiMessage.message
			if (!isPluginUiResponse(message) || message.__pluginResponse.id !== id) return
			window.removeEventListener("message", handler)
			if (message.__pluginResponse.error) reject(new Error(message.__pluginResponse.error))
			else resolve(message.__pluginResponse.result)
		}
		window.addEventListener("message", handler)
		vscode.postMessage({
			type: "pluginUiMessage",
			pluginUiMessage: {
				pluginName,
				message: { __pluginRequest: { id, method, params, mutates: opts?.mutates } },
			},
		})
	})
}
