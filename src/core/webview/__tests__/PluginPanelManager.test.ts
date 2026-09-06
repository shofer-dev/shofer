// npx vitest src/core/webview/__tests__/PluginPanelManager.test.ts

/**
 * A plugin's UI hosted in its own editor tab. The panel is a SECOND document for
 * the same plugin channel, so the things that must hold are about keeping it
 * equivalent to the sidebar mount rather than about rendering:
 *
 *  - one panel per `plugin:region` (a second open REVEALS rather than duplicates,
 *    or the plugin's UI would exist twice on one channel);
 *  - UI→plugin messages are routed through the SAME `handlePluginUiMessage` path;
 *  - plugin→UI broadcasts reach only that plugin's panels;
 *  - the panel carries its own locale bundles and language, because it has its
 *    own i18next instance the sidebar's registration does not reach; and
 *  - a plugin that contributes no bundle for the region gets a logged, empty
 *    panel rather than a crash.
 */

const hoisted = vi.hoisted(() => ({
	createWebviewPanel: vi.fn(),
	uiAssetRoots: ["/plugins/a/ui"] as string[],
	contributions: [] as Array<{ pluginName: string; region: string; source: string }>,
	locales: [] as Array<{ pluginName: string; language: string }>,
}))

vi.mock("vscode", () => ({
	ViewColumn: { Beside: -2, Active: -1 },
	Uri: {
		file: (p: string) => ({ fsPath: p, path: p, toString: () => `file://${p}` }),
		joinPath: (base: { fsPath: string }, ...parts: string[]) => {
			const fsPath = [base.fsPath, ...parts].join("/")
			return { fsPath, path: fsPath, toString: () => `file://${fsPath}` }
		},
	},
	window: { createWebviewPanel: (...args: unknown[]) => hoisted.createWebviewPanel(...args) },
}))

import { PluginPanelManager } from "../PluginPanelManager"
import type { ShoferProvider } from "../ShoferProvider"

function makePanel() {
	const listeners: { message?: (m: unknown) => void; dispose?: () => void } = {}
	return {
		listeners,
		reveal: vi.fn(),
		dispose: vi.fn(),
		webview: {
			html: "",
			cspSource: "vscode-webview://csp",
			asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => `webview://${uri.fsPath}` }),
			postMessage: vi.fn(),
			onDidReceiveMessage: vi.fn((cb: (m: unknown) => void) => void (listeners.message = cb)),
		},
		onDidDispose: vi.fn((cb: () => void) => void (listeners.dispose = cb)),
	}
}

function makeProvider(overrides: { currentTaskId?: string } = {}) {
	return {
		contextProxy: { extensionUri: { fsPath: "/ext", path: "/ext", toString: () => "file:///ext" } },
		log: vi.fn(),
		getPluginManager: vi.fn(async () => ({
			getUiAssetRoots: () => hoisted.uiAssetRoots,
			getContributedUiContributions: (resolve: (p: string) => string) =>
				hoisted.contributions.map((c) => ({ ...c, source: resolve(c.source) })),
			getContributedLocales: async () => hoisted.locales,
		})),
		getState: vi.fn(async () => ({ mode: "code", language: "fr" })),
		getCurrentTask: vi.fn(() => (overrides.currentTaskId ? { taskId: overrides.currentTaskId } : undefined)),
		handlePluginUiMessage: vi.fn(async () => undefined),
	} as unknown as ShoferProvider & {
		log: ReturnType<typeof vi.fn>
		handlePluginUiMessage: ReturnType<typeof vi.fn>
	}
}

const opts = { pluginName: "live-memory", region: "sidebar-panel" as never, title: "Live Memory" }

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.uiAssetRoots = ["/plugins/a/ui"]
	hoisted.contributions = [{ pluginName: "live-memory", region: "sidebar-panel", source: "/plugins/a/ui/panel.js" }]
	hoisted.locales = [{ pluginName: "live-memory", language: "fr" }]
})

describe("openPluginUiPanel", () => {
	it("creates the panel BESIDE the editor without stealing focus", async () => {
		hoisted.createWebviewPanel.mockReturnValueOnce(makePanel())
		const manager = new PluginPanelManager(makeProvider())

		await manager.openPluginUiPanel(opts)

		const [viewType, title, showOptions, panelOptions] = hoisted.createWebviewPanel.mock.calls[0]
		expect(viewType).toBe("shofer.pluginPanel")
		expect(title).toBe("Live Memory")
		expect(showOptions).toEqual({ viewColumn: -2, preserveFocus: true })
		expect(panelOptions).toMatchObject({ enableScripts: true, retainContextWhenHidden: true })
	})

	it("allows the extension root AND every plugin's UI asset root as local resources", async () => {
		hoisted.createWebviewPanel.mockReturnValueOnce(makePanel())
		const manager = new PluginPanelManager(makeProvider())

		await manager.openPluginUiPanel(opts)

		const roots = hoisted.createWebviewPanel.mock.calls[0][3].localResourceRoots as Array<{ fsPath: string }>
		expect(roots.map((r) => r.fsPath)).toEqual(["/ext", "/plugins/a/ui"])
	})

	it("REVEALS an already-open panel instead of opening a second one", async () => {
		const panel = makePanel()
		hoisted.createWebviewPanel.mockReturnValueOnce(panel)
		const manager = new PluginPanelManager(makeProvider())

		await manager.openPluginUiPanel(opts)
		await manager.openPluginUiPanel(opts)

		expect(hoisted.createWebviewPanel).toHaveBeenCalledTimes(1)
		expect(panel.reveal).toHaveBeenCalledWith(-2, true)
	})

	it("keys panels by plugin AND region, so two regions of one plugin coexist", async () => {
		hoisted.contributions.push({
			pluginName: "live-memory",
			region: "editor-panel",
			source: "/plugins/a/ui/two.js",
		})
		hoisted.createWebviewPanel.mockReturnValueOnce(makePanel()).mockReturnValueOnce(makePanel())
		const manager = new PluginPanelManager(makeProvider())

		await manager.openPluginUiPanel(opts)
		await manager.openPluginUiPanel({ ...opts, region: "editor-panel" as never })

		expect(hoisted.createWebviewPanel).toHaveBeenCalledTimes(2)
	})

	it("resolves the bundle against THIS panel's webview and injects it into the document", async () => {
		const panel = makePanel()
		hoisted.createWebviewPanel.mockReturnValueOnce(panel)
		const manager = new PluginPanelManager(makeProvider({ currentTaskId: "t-1" }))

		await manager.openPluginUiPanel(opts)

		const config = JSON.parse(panel.webview.html.match(/__shoferPluginPanel = (\{.*?\})\n/s)![1])
		expect(config.bundleUri).toBe("webview:///plugins/a/ui/panel.js")
		expect(config.pluginName).toBe("live-memory")
		expect(config.region).toBe("sidebar-panel")
		expect(config.task).toEqual({ taskId: "t-1", mode: "code" })
		expect(config.language).toBe("fr")
	})

	it("carries only THIS plugin's locale bundles — the panel has its own i18next", async () => {
		hoisted.locales = [
			{ pluginName: "live-memory", language: "fr" },
			{ pluginName: "someone-else", language: "fr" },
		]
		const panel = makePanel()
		hoisted.createWebviewPanel.mockReturnValueOnce(panel)
		const manager = new PluginPanelManager(makeProvider())

		await manager.openPluginUiPanel(opts)

		const config = JSON.parse(panel.webview.html.match(/__shoferPluginPanel = (\{.*?\})\n/s)![1])
		expect(config.locales).toEqual([{ pluginName: "live-memory", language: "fr" }])
	})

	it("LOGS and opens an empty panel when the plugin contributes no bundle for the region", async () => {
		hoisted.contributions = []
		const panel = makePanel()
		hoisted.createWebviewPanel.mockReturnValueOnce(panel)
		const provider = makeProvider()
		const manager = new PluginPanelManager(provider)

		await manager.openPluginUiPanel(opts)

		expect(provider.log).toHaveBeenCalledWith(expect.stringContaining("no UI bundle source resolved"))
		expect(panel.webview.html).toContain('<div id="root"></div>')
	})

	it("ships a nonce'd strict-dynamic CSP and the shared-React import map", async () => {
		const panel = makePanel()
		hoisted.createWebviewPanel.mockReturnValueOnce(panel)
		const manager = new PluginPanelManager(makeProvider())

		await manager.openPluginUiPanel(opts)

		expect(panel.webview.html).toContain("default-src 'none'")
		expect(panel.webview.html).toContain("'strict-dynamic'")
		expect(panel.webview.html).toContain('type="importmap"')
		const nonce = panel.webview.html.match(/'nonce-([^']+)'/)![1]
		expect(panel.webview.html).toContain(`<script nonce="${nonce}" type="module"`)
	})

	it("ESCAPES the plugin name in the document title", async () => {
		const panel = makePanel()
		hoisted.createWebviewPanel.mockReturnValueOnce(panel)
		const manager = new PluginPanelManager(makeProvider())

		await manager.openPluginUiPanel({ ...opts, pluginName: '<img src=x onerror="alert(1)">' })

		expect(panel.webview.html).toContain("<title>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</title>")
	})
})

describe("the panel's channel", () => {
	it("routes a pluginUiMessage envelope through the SAME handler the sidebar uses", async () => {
		const panel = makePanel()
		hoisted.createWebviewPanel.mockReturnValueOnce(panel)
		const provider = makeProvider()
		await new PluginPanelManager(provider).openPluginUiPanel(opts)

		panel.listeners.message!({
			type: "pluginUiMessage",
			pluginUiMessage: { pluginName: "live-memory", message: { a: 1 } },
		})

		expect(provider.handlePluginUiMessage).toHaveBeenCalledWith({ pluginName: "live-memory", message: { a: 1 } })
	})

	it("ignores anything that is not a pluginUiMessage envelope", async () => {
		const panel = makePanel()
		hoisted.createWebviewPanel.mockReturnValueOnce(panel)
		const provider = makeProvider()
		await new PluginPanelManager(provider).openPluginUiPanel(opts)

		panel.listeners.message!({ type: "somethingElse" })
		panel.listeners.message!(undefined)
		panel.listeners.message!({ type: "pluginUiMessage" })

		expect(provider.handlePluginUiMessage).not.toHaveBeenCalled()
	})

	it("broadcast reaches only the named plugin's panels", async () => {
		hoisted.contributions.push({ pluginName: "other", region: "sidebar-panel", source: "/plugins/b/ui/panel.js" })
		const mine = makePanel()
		const theirs = makePanel()
		hoisted.createWebviewPanel.mockReturnValueOnce(mine).mockReturnValueOnce(theirs)
		const manager = new PluginPanelManager(makeProvider())
		await manager.openPluginUiPanel(opts)
		await manager.openPluginUiPanel({ ...opts, pluginName: "other" })

		manager.broadcast("live-memory", { state: 1 })

		expect(mine.webview.postMessage).toHaveBeenCalledWith({
			type: "pluginUiMessage",
			pluginUiMessage: { pluginName: "live-memory", message: { state: 1 } },
		})
		expect(theirs.webview.postMessage).not.toHaveBeenCalled()
	})

	it("broadcast to a plugin with no open panel is a no-op", () => {
		expect(() => new PluginPanelManager(makeProvider()).broadcast("nobody", {})).not.toThrow()
	})
})

describe("lifecycle", () => {
	it("forgets a panel the user closed, so the next open creates a fresh one", async () => {
		const first = makePanel()
		const second = makePanel()
		hoisted.createWebviewPanel.mockReturnValueOnce(first).mockReturnValueOnce(second)
		const manager = new PluginPanelManager(makeProvider())

		await manager.openPluginUiPanel(opts)
		first.listeners.dispose!()
		await manager.openPluginUiPanel(opts)

		expect(hoisted.createWebviewPanel).toHaveBeenCalledTimes(2)
	})

	it("dispose() closes every panel and clears the map", async () => {
		const panel = makePanel()
		hoisted.createWebviewPanel.mockReturnValueOnce(panel)
		const manager = new PluginPanelManager(makeProvider())
		await manager.openPluginUiPanel(opts)

		manager.dispose()

		expect(panel.dispose).toHaveBeenCalled()
		manager.broadcast("live-memory", {})
		expect(panel.webview.postMessage).not.toHaveBeenCalled()
	})

	it("dispose() SWALLOWS a panel that throws on close — teardown must complete", async () => {
		const bad = makePanel()
		bad.dispose = vi.fn(() => {
			throw new Error("already disposed")
		})
		hoisted.createWebviewPanel.mockReturnValueOnce(bad)
		const manager = new PluginPanelManager(makeProvider())
		await manager.openPluginUiPanel(opts)

		expect(() => manager.dispose()).not.toThrow()
	})
})
