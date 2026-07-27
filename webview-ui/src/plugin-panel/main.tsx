/**
 * plugin-panel — the standalone `WebviewPanel` host for ONE plugin UI bundle
 * (design §6.8; the editor-tab counterpart of the in-sidebar `PluginSlot` mount).
 *
 * A separate Vite entry (its own webview document) built to `webview-ui/build/`. The
 * extension's {@link PluginPanelManager} creates a `vscode.window.createWebviewPanel`,
 * injects `window.__shoferPluginPanel = { bundleUri, pluginName, region, task }` and the
 * shared-React import map, then loads this entry. This module:
 *
 *  1. Publishes THIS document's React on the `__shoferHost*` globals (BEFORE importing
 *     the plugin bundle) so the dynamically-imported bundle — whose `react` specifiers
 *     resolve via the injected import map to the `plugin-host/*` shims — shares this one
 *     React instance (a second copy silently breaks hooks/context). Same boundary as
 *     `webview-ui/src/index.tsx`, but for this panel document.
 *  2. Builds the restricted {@link PluginUIApi} (scoped, name-tagged channel — mirrors
 *     `pluginUiChannel.ts`) + read-only context.
 *  3. Dynamic-imports the plugin bundle and renders its default/`component` export inside
 *     an error boundary that never lets a plugin crash blank the panel silently.
 */

import { Component, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import * as HostReact from "react"
import * as HostReactDom from "react-dom"
import * as HostReactDomClient from "react-dom/client"
import * as HostJsxRuntime from "react/jsx-runtime"
import * as HostJsxDevRuntime from "react/jsx-dev-runtime"
import * as HostPluginUi from "../plugin-ui"

import i18next, { loadPluginTranslations } from "@/i18n/setup"
import { PluginUiMountContext } from "@/components/plugins/PluginUiMountContext"

import {
	isPluginUiResponse,
	type PluginUIApi,
	type PluginUIContext,
	type PluginLocaleBundle,
	type PluginUiRegion,
	type PluginUiTaskSummary,
} from "@shofer/types"

// ---------------------------------------------------------------------------
// Shared-React boundary for the dynamically-imported plugin UI bundle (design §6.8).
// Published synchronously at module-eval time — well before the plugin bundle is
// imported in `boot()` below — so the bundle's `import ... from "react"` (resolved via
// the panel HTML's import map to `plugin-host/react.js`) reuses THIS React instance.
// ---------------------------------------------------------------------------
;(globalThis as unknown as Record<string, unknown>).__shoferHostReact = HostReact
;(globalThis as unknown as Record<string, unknown>).__shoferHostReactDom = HostReactDom
;(globalThis as unknown as Record<string, unknown>).__shoferHostReactDomClient = HostReactDomClient
;(globalThis as unknown as Record<string, unknown>).__shoferHostJsxRuntime = HostJsxRuntime
;(globalThis as unknown as Record<string, unknown>).__shoferHostJsxDevRuntime = HostJsxDevRuntime
// …and the component kit + translation hook the bundle imports as `@shofer/plugin-ui`.
;(globalThis as unknown as Record<string, unknown>).__shoferPluginUi = HostPluginUi

/** The config the extension injects onto the panel document before this script runs. */
interface PluginPanelConfig {
	/** `vscode-webview://` URI of the plugin's built UI ESM module (its region entry). */
	bundleUri: string
	/** Contributing plugin's name — the channel namespace. */
	pluginName: string
	/** The contributed region whose bundle this panel hosts. */
	region: string
	/** Read-only summary of the active task, if any. */
	task?: PluginUiTaskSummary
	/** This plugin's own translations (its `locales/<lang>.json` files). */
	locales?: PluginLocaleBundle[]
	/** The user's display language, so the panel matches the sidebar. */
	language?: string
}

type PluginPanelComponent = (props: { api: PluginUIApi }) => ReactNode

/** Error boundary around the plugin component: on throw, show a minimal notice + warn. */
class PluginErrorBoundary extends Component<{ pluginName: string; children: ReactNode }, { crashed: boolean }> {
	constructor(props: { pluginName: string; children: ReactNode }) {
		super(props)
		this.state = { crashed: false }
	}
	static getDerivedStateFromError(): { crashed: boolean } {
		return { crashed: true }
	}
	componentDidCatch(error: unknown): void {
		console.warn(`[plugin:${this.props.pluginName}] panel UI component crashed:`, error)
	}
	render(): ReactNode {
		if (this.state.crashed) {
			return (
				<div
					style={{
						padding: 16,
						color: "var(--vscode-errorForeground)",
						fontFamily: "var(--vscode-font-family)",
					}}>
					This plugin panel failed to render.
				</div>
			)
		}
		return this.props.children
	}
}

/** Build the per-panel, plugin-scoped {@link PluginUIApi} (mirrors `pluginUiChannel.ts`). */
function buildApi(config: PluginPanelConfig): PluginUIApi {
	// A single `acquireVsCodeApi()` per document (calling twice throws) — this panel is
	// its own document, independent of the main sidebar webview's singleton.
	const vscodeApi = acquireVsCodeApi()
	const { pluginName } = config
	const context: PluginUIContext = {
		region: config.region as PluginUiRegion,
		pluginName,
		task: config.task,
	}
	return {
		postMessage(message: unknown): void {
			vscodeApi.postMessage({ type: "pluginUiMessage", pluginUiMessage: { pluginName, message } })
		},
		onMessage(listener: (message: unknown) => void): () => void {
			const handler = (event: MessageEvent) => {
				const data = event.data as
					| { type?: string; pluginUiMessage?: { pluginName?: string; message?: unknown } }
					| undefined
				if (data?.type === "pluginUiMessage" && data.pluginUiMessage?.pluginName === pluginName) {
					// Request/response traffic belongs to `request()`, not to observers.
					if (isPluginUiResponse(data.pluginUiMessage.message)) return
					listener(data.pluginUiMessage.message)
				}
			}
			window.addEventListener("message", handler)
			return () => window.removeEventListener("message", handler)
		},
		request(method: string, params?: unknown): Promise<unknown> {
			const id = `${pluginName}:panel:${nextPanelRequestId++}`
			return new Promise((resolve, reject) => {
				const handler = (event: MessageEvent) => {
					const data = event.data as
						| { type?: string; pluginUiMessage?: { pluginName?: string; message?: unknown } }
						| undefined
					if (data?.type !== "pluginUiMessage" || data.pluginUiMessage?.pluginName !== pluginName) return
					const message = data.pluginUiMessage.message
					if (!isPluginUiResponse(message) || message.__pluginResponse.id !== id) return
					window.removeEventListener("message", handler)
					if (message.__pluginResponse.error) reject(new Error(message.__pluginResponse.error))
					else resolve(message.__pluginResponse.result)
				}
				window.addEventListener("message", handler)
				vscodeApi.postMessage({
					type: "pluginUiMessage",
					pluginUiMessage: { pluginName, message: { __pluginRequest: { id, method, params } } },
				})
			})
		},
		context,
	}
}

/** Monotonic correlation ids for this panel's {@link PluginUIApi.request} calls. */
let nextPanelRequestId = 0

async function boot(): Promise<void> {
	const root = document.getElementById("root")
	if (!root) return
	const config = (window as unknown as { __shoferPluginPanel?: PluginPanelConfig }).__shoferPluginPanel
	if (!config?.bundleUri || !config.pluginName) {
		root.textContent = "Plugin panel misconfigured (no bundle)."
		return
	}

	// This panel is its own document with its own i18next instance: register the
	// plugin's strings and follow the user's language, or its UI would render keys.
	loadPluginTranslations(config.locales ?? [])
	if (config.language) void i18next.changeLanguage(config.language)

	const api = buildApi(config)
	let Component: PluginPanelComponent | undefined
	try {
		// `@vite-ignore` keeps Vite from trying to statically resolve this runtime URL.
		const mod = (await import(/* @vite-ignore */ config.bundleUri)) as {
			default?: PluginPanelComponent
			component?: PluginPanelComponent
		}
		Component = mod.default ?? mod.component
	} catch (error) {
		console.warn(`[plugin:${config.pluginName}] failed to load panel bundle "${config.bundleUri}":`, error)
	}

	if (!Component) {
		root.textContent = "Plugin panel bundle exported no component."
		return
	}

	createRoot(root).render(
		<PluginErrorBoundary pluginName={config.pluginName}>
			<PluginUiMountContext.Provider value={{ pluginName: config.pluginName }}>
				<Component api={api} />
			</PluginUiMountContext.Provider>
		</PluginErrorBoundary>,
	)
}

void boot()
