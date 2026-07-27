import * as vscode from "vscode"

import { getUri } from "./getUri"

/**
 * Build the shared-React `<script type="importmap">` payload for external plugin UI
 * bundles (design §6.8, P4) — the single source of truth used by BOTH the main sidebar
 * webview ({@link import("./ShoferProvider").ShoferProvider.getHtmlContent}) and the
 * standalone plugin-panel webview ({@link import("./PluginPanelManager").PluginPanelManager}).
 *
 * A plugin bundle externalizes `react`/`react-dom`/`react/jsx-runtime` and
 * `@shofer/plugin-ui`, so those bare specifiers stay in its output; this map resolves
 * them to the host-shim modules under `webview-ui/build/plugin-host/*` (served as
 * `vscode-webview://` resources), which re-export the host document's already-running
 * React instance and component kit. Importing same-origin `cspSource` modules is
 * permitted under the CSP's `strict-dynamic`.
 *
 * @returns the JSON string to embed inside `<script type="importmap">…</script>`.
 */
export function buildPluginHostImportMap(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const pluginHostUri = (file: string) =>
		String(getUri(webview, extensionUri, ["webview-ui", "build", "plugin-host", file]))
	return JSON.stringify({
		imports: {
			react: pluginHostUri("react.js"),
			"react-dom": pluginHostUri("react-dom.js"),
			"react-dom/client": pluginHostUri("react-dom-client.js"),
			"react/jsx-runtime": pluginHostUri("jsx-runtime.js"),
			"react/jsx-dev-runtime": pluginHostUri("jsx-dev-runtime.js"),
			"@shofer/plugin-ui": pluginHostUri("plugin-ui.js"),
		},
	})
}
