import * as vscode from "vscode"

import type { PluginUiRegion } from "@shofer/types"

import { getNonce } from "./getNonce"
import { getUri } from "./getUri"
import { buildPluginHostImportMap } from "./pluginHostImportMap"
import type { ShoferProvider } from "./ShoferProvider"

/** Options for {@link PluginPanelManager.openPluginUiPanel}. */
export interface OpenPluginUiPanelOptions {
	/** Contributing plugin's name — the channel namespace + map key. */
	pluginName: string
	/** Which contributed UI region's bundle to host (e.g. `"sidebar-panel"`). */
	region: PluginUiRegion
	/** Editor-tab title. */
	title: string
}

/**
 * PluginPanelManager — opens a plugin's UI bundle in a standalone `WebviewPanel` editor
 * tab (design §6.8), the editor-tab counterpart of the in-sidebar `PluginSlot` mount.
 * This is the generic, reusable host for `ctx.ui.showPanel()` — matching the removed
 * built-in `LiveMemoryChatProvider` (title-driven panel, `ViewColumn.Beside`,
 * `preserveFocus: true`, reveal-if-open, disposed on close), but for ANY plugin's bundle
 * (nothing here is plugin-specific — the manifest/plugin drives title + region).
 *
 * The panel document loads the standalone `plugin-panel` webview entry
 * (`webview-ui/build/assets/pluginPanel.js`), which dynamic-imports the plugin's bundle
 * over the SAME scoped, name-tagged plugin-UI channel as the sidebar mount:
 *  - UI → plugin: `panel.webview.onDidReceiveMessage` routes `pluginUiMessage` envelopes
 *    through the SAME {@link ShoferProvider.handlePluginUiMessage} path the main webview uses.
 *  - plugin → UI: {@link ShoferProvider.postPluginUiMessage} fans out to {@link broadcast},
 *    so a plugin's `ctx.ui.postMessage` state pushes reach open panels too.
 */
export class PluginPanelManager {
	/** Open panels keyed by `pluginName:region`. */
	private readonly panels = new Map<string, vscode.WebviewPanel>()

	constructor(private readonly provider: ShoferProvider) {}

	private key(pluginName: string, region: string): string {
		return `${pluginName}:${region}`
	}

	/**
	 * Open — or, if already open, focus — the plugin's UI bundle in a `WebviewPanel`.
	 * Mirrors the built-in `LiveMemoryChatProvider`: reveal-if-open, else create beside
	 * the editor with focus preserved. No-op (with a log) when the plugin contributes no
	 * bundle for `region`.
	 */
	async openPluginUiPanel(opts: OpenPluginUiPanelOptions): Promise<void> {
		const { pluginName, region, title } = opts
		const mapKey = this.key(pluginName, region)

		const existing = this.panels.get(mapKey)
		if (existing) {
			existing.reveal(vscode.ViewColumn.Beside, true)
			return
		}

		const extensionUri = this.provider.contextProxy.extensionUri
		const manager = await this.provider.getPluginManager()

		const panel = vscode.window.createWebviewPanel(
			"shofer.pluginPanel",
			title,
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [extensionUri, ...manager.getUiAssetRoots().map((root) => vscode.Uri.file(root))],
			},
		)

		// Resolve the plugin's UI bundle entry for `region` to a served `vscode-webview://`
		// URI on THIS panel's webview (the source must be resolved against the document
		// that will import it). Falls back to no panel content if the plugin contributes none.
		const resolveSource = (absolutePath: string) => String(panel.webview.asWebviewUri(vscode.Uri.file(absolutePath)))
		const contributions = manager.getContributedUiContributions(resolveSource)
		const contribution = contributions.find((c) => c.pluginName === pluginName && c.region === region)
		const bundleUri = contribution?.source

		if (!bundleUri) {
			this.provider.log(
				`[plugin-panel] ${pluginName}:${region} — no UI bundle source resolved; opening an empty panel`,
			)
		}

		const task = { taskId: this.provider.getCurrentTask()?.taskId, mode: (await this.provider.getState()).mode }

		panel.webview.html = this.buildHtml(panel.webview, extensionUri, { bundleUri, pluginName, region, task })

		// UI → plugin: route the panel's scoped channel messages through the SAME path the
		// main sidebar webview uses (namespaced by pluginName inside the registry).
		panel.webview.onDidReceiveMessage((message: unknown) => {
			const data = message as { type?: string; pluginUiMessage?: { pluginName: string; message: unknown } } | undefined
			if (data?.type === "pluginUiMessage" && data.pluginUiMessage) {
				void this.provider.handlePluginUiMessage(data.pluginUiMessage)
			}
		})

		panel.onDidDispose(() => {
			if (this.panels.get(mapKey) === panel) this.panels.delete(mapKey)
		})

		this.panels.set(mapKey, panel)
	}

	/**
	 * Fan out an extension → UI push to every open panel of `pluginName` (design §6.8).
	 * Called by {@link ShoferProvider.postPluginUiMessage} so a plugin's `ctx.ui` state
	 * pushes reach open panels, not just the main sidebar webview. Fire-and-forget.
	 */
	broadcast(pluginName: string, message: unknown): void {
		const prefix = `${pluginName}:`
		for (const [mapKey, panel] of this.panels) {
			if (!mapKey.startsWith(prefix)) continue
			void panel.webview.postMessage({ type: "pluginUiMessage", pluginUiMessage: { pluginName, message } })
		}
	}

	/** Dispose every open panel (on provider dispose). */
	dispose(): void {
		for (const panel of this.panels.values()) {
			try {
				panel.dispose()
			} catch {
				// best-effort
			}
		}
		this.panels.clear()
	}

	/**
	 * Build the panel document HTML: the standalone `plugin-panel` entry script + shared
	 * CSS, the SAME shared-React import map ShoferProvider injects for plugin bundles, a
	 * strict nonce'd CSP (`strict-dynamic` so the nonce'd entry may dynamic-import the
	 * same-origin plugin bundle + host-React shims), and the injected panel config.
	 */
	private buildHtml(
		webview: vscode.Webview,
		extensionUri: vscode.Uri,
		config: { bundleUri?: string; pluginName: string; region: string; task: unknown },
	): string {
		const nonce = getNonce()
		const scriptUri = getUri(webview, extensionUri, ["webview-ui", "build", "assets", "pluginPanel.js"])
		const stylesUri = getUri(webview, extensionUri, ["webview-ui", "build", "assets", "index.css"])
		const codiconsUri = getUri(webview, extensionUri, ["assets", "codicons", "codicon.css"])
		const importMap = buildPluginHostImportMap(webview, extensionUri)

		const csp = [
			"default-src 'none'",
			`font-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`img-src ${webview.cspSource} https: data:`,
			`media-src ${webview.cspSource}`,
			`script-src ${webview.cspSource} 'nonce-${nonce}' 'strict-dynamic'`,
			`connect-src ${webview.cspSource}`,
		].join("; ")

		return /*html*/ `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<meta http-equiv="Content-Security-Policy" content="${csp}" />
		<link rel="stylesheet" type="text/css" href="${stylesUri}" />
		<link href="${codiconsUri}" rel="stylesheet" />
		<!-- Shared-React import map (design §6.8, P4) — must precede the entry module. -->
		<script type="importmap" nonce="${nonce}">${importMap}</script>
		<script nonce="${nonce}">
			window.__shoferPluginPanel = ${JSON.stringify(config)}
		</script>
		<title>${escapeHtml(config.pluginName)}</title>
	</head>
	<body>
		<div id="root"></div>
		<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
	</body>
</html>`
	}
}

/** Minimal HTML-escape for values interpolated into markup (the title). */
function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
