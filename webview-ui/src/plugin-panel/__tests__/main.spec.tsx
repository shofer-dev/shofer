// npx vitest src/plugin-panel/__tests__/main.spec.tsx
//
// The standalone plugin-panel document. Its whole job is to hand a plugin
// bundle THIS document's React plus a plugin-scoped `PluginUIApi`, and to fail
// visibly rather than blank when the bundle is missing, unloadable, or crashes.

import { act } from "@/utils/test-utils"

const createRoot = vi.fn((_container: Element) => ({ render: vi.fn() as (element: unknown) => void }))
vi.mock("react-dom/client", async () => {
	const actual = await vi.importActual<Record<string, unknown>>("react-dom/client")
	return { ...actual, createRoot: (...a: Parameters<typeof createRoot>) => createRoot(...a) }
})

const changeLanguage = vi.fn()
const loadPluginTranslations = vi.fn()
vi.mock("@/i18n/setup", () => ({
	default: { changeLanguage: (l: string) => changeLanguage(l) },
	loadPluginTranslations: (b: unknown) => loadPluginTranslations(b),
}))

const hostPostMessage = vi.fn()
const globals = globalThis as unknown as Record<string, unknown>

/**
 * Reset the document and the injected config, then re-run the entry module.
 *
 * `boot()` is fire-and-forget inside the module and awaits a dynamic import of
 * the bundle URL, so a single macrotask is not enough under load — poll until
 * the entry has either mounted or written its failure text.
 */
const settle = async (root: HTMLElement) => {
	for (let i = 0; i < 50; i++) {
		if (createRoot.mock.calls.length > 0 || root.textContent) return
		await act(async () => {
			await new Promise((r) => setTimeout(r, 5))
		})
	}
}

const boot = async (config?: Record<string, unknown>) => {
	document.body.innerHTML = '<div id="root"></div>'
	;(window as unknown as Record<string, unknown>).__shoferPluginPanel = config
	vi.resetModules()
	await act(async () => {
		await import("../main")
		await new Promise((r) => setTimeout(r, 0))
	})
	const root = document.getElementById("root")!
	await settle(root)
	return root
}

beforeAll(() => {
	;(window as unknown as Record<string, unknown>).acquireVsCodeApi = () => ({
		postMessage: hostPostMessage,
		getState: () => undefined,
		setState: () => undefined,
	})
})

beforeEach(() => {
	vi.clearAllMocks()
	vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe("plugin panel boot", () => {
	it("publishes the shared-React globals before anything else", async () => {
		await boot({ bundleUri: "", pluginName: "" })
		for (const key of [
			"__shoferHostReact",
			"__shoferHostReactDomClient",
			"__shoferHostJsxRuntime",
			"__shoferPluginUi",
		]) {
			expect(globals[key]).toBeTruthy()
		}
	})

	it("says so when the host injected no config", async () => {
		const root = await boot(undefined)
		expect(root.textContent).toBe("Plugin panel misconfigured (no bundle).")
		expect(createRoot).not.toHaveBeenCalled()
	})

	it("says so when the config names no bundle", async () => {
		const root = await boot({ pluginName: "basics" })
		expect(root.textContent).toBe("Plugin panel misconfigured (no bundle).")
	})

	it("says so when the bundle exports no component", async () => {
		const uri = "data:text/javascript,export const nothing = 1"
		const root = await boot({ bundleUri: uri, pluginName: "basics", region: "panel" })
		expect(root.textContent).toBe("Plugin panel bundle exported no component.")
	})

	it("reports, rather than blanks on, a bundle that will not load", async () => {
		const root = await boot({
			bundleUri: "data:text/javascript,throw new Error('bundle blew up')",
			pluginName: "basics",
			region: "panel",
		})
		expect(console.warn).toHaveBeenCalled()
		expect(root.textContent).toBe("Plugin panel bundle exported no component.")
	})

	it("mounts the bundle's default export and registers its translations", async () => {
		const uri = "data:text/javascript,export default function C() { return null }"
		await boot({
			bundleUri: uri,
			pluginName: "basics",
			region: "panel",
			locales: [{ language: "en", translations: {} }],
			language: "fr",
		})

		expect(loadPluginTranslations).toHaveBeenCalledWith([{ language: "en", translations: {} }])
		expect(changeLanguage).toHaveBeenCalledWith("fr")
		expect(createRoot).toHaveBeenCalledWith(document.getElementById("root"))
	})

	it("accepts a `component` named export too, and defaults the locale bundle", async () => {
		const uri = "data:text/javascript,export const component = function C() { return null }"
		await boot({ bundleUri: uri, pluginName: "basics", region: "panel" })
		expect(loadPluginTranslations).toHaveBeenCalledWith([])
		expect(changeLanguage).not.toHaveBeenCalled()
		expect(createRoot).toHaveBeenCalled()
	})

	it("does nothing at all without a #root element", async () => {
		document.body.innerHTML = ""
		;(window as unknown as Record<string, unknown>).__shoferPluginPanel = {
			bundleUri: "data:text/javascript,export default function C(){return null}",
			pluginName: "basics",
		}
		vi.resetModules()
		await act(async () => {
			await import("../main")
			await new Promise((r) => setTimeout(r, 20))
		})
		expect(createRoot).not.toHaveBeenCalled()
	})
})

describe("the plugin-scoped api the panel builds", () => {
	/** Capture the `api` prop the mounted component was handed. */
	const bootAndCaptureApi = async () => {
		let captured: Record<string, any> | undefined
		createRoot.mockImplementation(() => ({
			render: (element: unknown) => {
				const el = element as any
				// <PluginErrorBoundary><Provider><Component api=… /></Provider></PluginErrorBoundary>
				captured = el.props.children.props.children.props.api
			},
		}))
		await boot({
			bundleUri: "data:text/javascript,export default function C(){return null}",
			pluginName: "basics",
			region: "panel",
			task: { id: "t1" },
		})
		createRoot.mockImplementation(() => ({ render: vi.fn() }))
		return captured!
	}

	it("carries the plugin-scoped read-only context", async () => {
		const api = await bootAndCaptureApi()
		expect(api.context).toEqual({ region: "panel", pluginName: "basics", task: { id: "t1" } })
	})

	it("namespaces every outbound message with the plugin's name", async () => {
		const api = await bootAndCaptureApi()
		api.postMessage({ hello: true })
		expect(hostPostMessage).toHaveBeenCalledWith({
			type: "pluginUiMessage",
			pluginUiMessage: { pluginName: "basics", message: { hello: true } },
		})
	})

	it("delivers only this plugin's observer traffic, and never a response", async () => {
		const api = await bootAndCaptureApi()
		const seen: unknown[] = []
		const off = api.onMessage((m: unknown) => seen.push(m))

		const deliver = (data: unknown) =>
			act(() => {
				window.dispatchEvent(new MessageEvent("message", { data }))
			})

		deliver({ type: "pluginUiMessage", pluginUiMessage: { pluginName: "basics", message: { a: 1 } } })
		deliver({ type: "pluginUiMessage", pluginUiMessage: { pluginName: "other", message: { b: 2 } } })
		deliver({ type: "somethingElse" })
		deliver({
			type: "pluginUiMessage",
			pluginUiMessage: {
				pluginName: "basics",
				message: { __pluginResponse: { id: "x", result: 1 } },
			},
		})

		expect(seen).toEqual([{ a: 1 }])

		off()
		deliver({ type: "pluginUiMessage", pluginUiMessage: { pluginName: "basics", message: { c: 3 } } })
		expect(seen).toEqual([{ a: 1 }])
	})

	it("resolves a request against its own correlation id, and rejects on an error", async () => {
		const api = await bootAndCaptureApi()

		const pending = api.request("getThing", { which: 1 })
		const sent = hostPostMessage.mock.calls.at(-1)![0]
		const id = sent.pluginUiMessage.message.__pluginRequest.id
		expect(sent.pluginUiMessage.message.__pluginRequest).toMatchObject({
			method: "getThing",
			params: { which: 1 },
		})

		// A response for a different id is ignored…
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "pluginUiMessage",
						pluginUiMessage: {
							pluginName: "basics",
							message: { __pluginResponse: { id: "someone-else", result: "no" } },
						},
					},
				}),
			)
		})

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "pluginUiMessage",
						pluginUiMessage: {
							pluginName: "basics",
							message: { __pluginResponse: { id, result: "yes" } },
						},
					},
				}),
			)
		})
		await expect(pending).resolves.toBe("yes")

		const failing = api.request("boom")
		const failingId = hostPostMessage.mock.calls.at(-1)![0].pluginUiMessage.message.__pluginRequest.id
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "pluginUiMessage",
						pluginUiMessage: {
							pluginName: "basics",
							message: { __pluginResponse: { id: failingId, error: "no such method" } },
						},
					},
				}),
			)
		})
		await expect(failing).rejects.toThrow("no such method")
	})

	it("ignores traffic addressed to another plugin while a request is pending", async () => {
		const api = await bootAndCaptureApi()
		let settled = false
		void api.request("m").then(() => (settled = true))

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "pluginUiMessage", pluginUiMessage: { pluginName: "other", message: {} } },
				}),
			)
		})
		await new Promise((r) => setTimeout(r, 0))
		expect(settled).toBe(false)
	})
})
