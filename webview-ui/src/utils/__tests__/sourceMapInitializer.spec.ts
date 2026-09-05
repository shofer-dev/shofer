// npx vitest src/utils/__tests__/sourceMapInitializer.spec.ts
//
// Production-only wiring: the initializer installs global error handlers and
// preloads source maps, and the debug helper hangs three functions on `window`.
// Both must be inert outside a production build.

import { exposeSourceMapsForDebugging, initializeSourceMaps } from "../sourceMapInitializer"

const enhanceErrorWithSourceMaps = vi.fn(async (e: Error) => e)
vi.mock("../sourceMapUtils", () => ({
	enhanceErrorWithSourceMaps: (e: Error) => enhanceErrorWithSourceMaps(e),
}))

const originalEnv = process.env.NODE_ENV
const globalWindow = window as unknown as Record<string, unknown>

const production = () => {
	process.env.NODE_ENV = "production"
}

beforeEach(() => {
	vi.clearAllMocks()
	document.head.innerHTML = ""
	document.body.innerHTML = ""
	delete globalWindow.__applySourceMaps
	delete globalWindow.__testSourceMaps
	delete globalWindow.__checkSourceMap
	vi.spyOn(console, "debug").mockImplementation(() => {})
	vi.spyOn(console, "error").mockImplementation(() => {})
	vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
	process.env.NODE_ENV = originalEnv
	vi.restoreAllMocks()
})

describe("initializeSourceMaps", () => {
	it("does nothing outside a production build", () => {
		const addEventListener = vi.spyOn(window, "addEventListener")
		initializeSourceMaps()
		expect(addEventListener).not.toHaveBeenCalled()
	})

	it("preloads every candidate map url for each script with a src", () => {
		production()
		const script = document.createElement("script")
		script.src = "https://host.test/assets/index.js"
		document.body.appendChild(script)
		// A src-less script contributes no preloads.
		document.body.appendChild(document.createElement("script"))
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ text: async () => "" }))

		initializeSourceMaps()

		const preloads = Array.from(document.head.querySelectorAll('link[rel="preload"]')).map(
			(l) => (l as HTMLLinkElement).href,
		)
		expect(preloads).toContain("https://host.test/assets/index.js.map")
		expect(preloads).toContain("https://host.test/assets/index.js?source-map=true")
		expect(preloads).toContain("https://host.test/assets/index.map.json")
		expect(preloads).toContain("https://host.test/assets/index.sourcemap")
	})

	it("preloads an inline sourceMappingURL comment, skipping a data url", async () => {
		production()
		const script = document.createElement("script")
		script.src = "https://host.test/assets/index.js"
		document.body.appendChild(script)
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ text: async () => "code\n//# sourceMappingURL=index.js.map\n" }),
		)

		initializeSourceMaps()
		await new Promise((r) => setTimeout(r, 0))

		const preloads = Array.from(document.head.querySelectorAll('link[rel="preload"]')).map(
			(l) => (l as HTMLLinkElement).href,
		)
		expect(preloads.filter((h) => h === "https://host.test/assets/index.js.map").length).toBeGreaterThan(1)
	})

	it("ignores a data: sourceMappingURL", async () => {
		production()
		const script = document.createElement("script")
		script.src = "https://host.test/assets/index.js"
		document.body.appendChild(script)
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ text: async () => "//# sourceMappingURL=data:application/json;base64,e30=" }),
		)

		initializeSourceMaps()
		await new Promise((r) => setTimeout(r, 0))
		expect(document.head.querySelectorAll('link[href^="data:"]')).toHaveLength(0)
	})

	it("survives a failed fetch of the script body", async () => {
		production()
		const script = document.createElement("script")
		script.src = "https://host.test/assets/index.js"
		document.body.appendChild(script)
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))

		expect(() => initializeSourceMaps()).not.toThrow()
		await new Promise((r) => setTimeout(r, 0))
	})

	it("enhances an uncaught error and an unhandled rejection", async () => {
		production()
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ text: async () => "" }))
		initializeSourceMaps()

		// Earlier tests in this file also installed handlers (the initializer
		// registers listeners it never removes), so the assertion is that THIS
		// error reached the mapper, not how many handlers saw it.
		window.dispatchEvent(Object.assign(new Event("error"), { error: new Error("boom") }))
		await new Promise((r) => setTimeout(r, 0))
		expect(enhanceErrorWithSourceMaps).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }))

		window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("nope") }))
		await new Promise((r) => setTimeout(r, 0))
		expect(enhanceErrorWithSourceMaps).toHaveBeenCalledWith(expect.objectContaining({ message: "nope" }))
	})

	it("ignores an error event carrying no Error", async () => {
		production()
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ text: async () => "" }))
		initializeSourceMaps()

		window.dispatchEvent(Object.assign(new Event("error"), { error: "just a string" }))
		window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: undefined }))
		await new Promise((r) => setTimeout(r, 0))
		expect(enhanceErrorWithSourceMaps).not.toHaveBeenCalled()
	})

	it("reports, rather than propagates, a failure to enhance", async () => {
		production()
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ text: async () => "" }))
		enhanceErrorWithSourceMaps.mockRejectedValueOnce(new Error("mapper down"))
		initializeSourceMaps()

		window.dispatchEvent(Object.assign(new Event("error"), { error: new Error("boom") }))
		await new Promise((r) => setTimeout(r, 0))
		expect(console.error).toHaveBeenCalled()
	})
})

describe("exposeSourceMapsForDebugging", () => {
	it("does nothing outside a production build", () => {
		exposeSourceMapsForDebugging()
		expect(globalWindow.__applySourceMaps).toBeUndefined()
	})

	it("exposes the three debugging helpers", () => {
		production()
		exposeSourceMapsForDebugging()
		expect(typeof globalWindow.__applySourceMaps).toBe("function")
		expect(typeof globalWindow.__testSourceMaps).toBe("function")
		expect(typeof globalWindow.__checkSourceMap).toBe("function")
	})

	it("__applySourceMaps enhances an Error and refuses anything else", async () => {
		production()
		exposeSourceMapsForDebugging()
		const apply = globalWindow.__applySourceMaps as (e: unknown) => Promise<unknown>

		const error = new Error("boom")
		await apply(error)
		expect(enhanceErrorWithSourceMaps).toHaveBeenCalledWith(error)

		await apply("not an error")
		expect(enhanceErrorWithSourceMaps).toHaveBeenCalledTimes(1)
	})

	it("__testSourceMaps triggers and enhances a synthetic error", async () => {
		production()
		exposeSourceMapsForDebugging()
		;(globalWindow.__testSourceMaps as () => void)()
		await new Promise((r) => setTimeout(r, 0))
		expect(enhanceErrorWithSourceMaps).toHaveBeenCalled()
	})

	it("__checkSourceMap reports a found map, a missing one, and a failure", async () => {
		production()
		exposeSourceMapsForDebugging()
		const check = globalWindow.__checkSourceMap as (u: string) => Promise<boolean>

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sources: ["src/index.tsx"] }) }),
		)
		expect(await check("https://host.test/a.js")).toBe(true)

		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
		expect(await check("https://host.test/a.js")).toBe(true)

		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }))
		expect(await check("https://host.test/a.js")).toBe(false)

		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
		expect(await check("https://host.test/a.js")).toBe(false)
	})
})
