// npx vitest src/__tests__/plugin-host-shims.spec.ts
//
// The shims in `public/plugin-host/` are what the webview's import map resolves
// a plugin bundle's bare `react` / `react-dom` / `react/jsx-runtime` /
// `@shofer/plugin-ui` specifiers to. Each re-exports the HOST instance published
// on a global at boot — a second copy of React would silently break hooks across
// the host↔plugin boundary. They are served VERBATIM from `public/` (never
// transformed), so nothing but these tests reads them at build time; a member
// dropped from one is invisible until a plugin crashes on it.

import * as ReactActual from "react"
import * as ReactDomActual from "react-dom"
import * as ReactDomClientActual from "react-dom/client"
import * as JsxRuntimeActual from "react/jsx-runtime"
import * as JsxDevRuntimeActual from "react/jsx-dev-runtime"
import * as PluginUiActual from "../plugin-ui"

const globals = globalThis as unknown as Record<string, unknown>

beforeAll(() => {
	globals.__shoferHostReact = ReactActual
	globals.__shoferHostReactDom = ReactDomActual
	globals.__shoferHostReactDomClient = ReactDomClientActual
	globals.__shoferHostJsxRuntime = JsxRuntimeActual
	globals.__shoferHostJsxDevRuntime = JsxDevRuntimeActual
	globals.__shoferPluginUi = PluginUiActual
})

describe("the react shim", () => {
	it("re-exports the host instance rather than a second copy", async () => {
		const shim = await import("../../public/plugin-host/react.js")

		expect(shim.default).toBe((ReactActual as Record<string, unknown>).default ?? ReactActual)
		for (const name of [
			"Children",
			"Component",
			"Fragment",
			"StrictMode",
			"createContext",
			"createElement",
			"useCallback",
			"useContext",
			"useEffect",
			"useMemo",
			"useRef",
			"useState",
		] as const) {
			expect((shim as Record<string, unknown>)[name]).toBe(
				(ReactActual as unknown as Record<string, unknown>)[name],
			)
		}
	})
})

describe("the react-dom shims", () => {
	it("re-export the host's DOM renderer and its client entry", async () => {
		const dom = await import("../../public/plugin-host/react-dom.js")
		expect(dom.createPortal).toBe(ReactDomActual.createPortal)
		expect(dom.flushSync).toBe(ReactDomActual.flushSync)

		const client = await import("../../public/plugin-host/react-dom-client.js")
		expect(client.createRoot).toBe(ReactDomClientActual.createRoot)
		expect(client.hydrateRoot).toBe(ReactDomClientActual.hydrateRoot)
	})
})

describe("the JSX runtime shims", () => {
	it("re-export the host's automatic runtime, production and development", async () => {
		const runtime = await import("../../public/plugin-host/jsx-runtime.js")
		expect(runtime.jsx).toBe(JsxRuntimeActual.jsx)
		expect(runtime.jsxs).toBe(JsxRuntimeActual.jsxs)
		expect(runtime.Fragment).toBe(JsxRuntimeActual.Fragment)

		const dev = await import("../../public/plugin-host/jsx-dev-runtime.js")
		expect(dev.jsxDEV).toBe(JsxDevRuntimeActual.jsxDEV)
		expect(dev.Fragment).toBe(JsxDevRuntimeActual.Fragment)
	})
})

describe("the plugin-ui shim", () => {
	it("re-exports the host's own component kit, member for member", async () => {
		const shim = (await import("../../public/plugin-host/plugin-ui.js")) as Record<string, unknown>
		const kit = PluginUiActual as unknown as Record<string, unknown>

		// The shim is served verbatim, so nothing checks it at build time: every
		// name it re-exports must exist in `src/plugin-ui/index.ts` or a plugin
		// importing it gets `undefined` and crashes at render.
		const exported = Object.keys(shim).filter((k) => k !== "default")
		expect(exported.length).toBeGreaterThan(10)
		for (const name of exported) {
			// Named per iteration so a failure says WHICH member drifted.
			expect({ name, value: shim[name] }).toEqual({ name, value: kit[name] })
			expect(shim[name]).toBeDefined()
		}
	})
})
