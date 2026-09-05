// npx vitest src/__tests__/index-entry.spec.tsx
//
// The webview's entry module. Everything it does happens at import time, and
// two of those things are load-bearing enough to pin:
//
//  * the shared-React boundary — a plugin bundle resolves bare `react` through
//    the import map to shims that re-export THESE globals, so a second React
//    copy (which silently breaks hooks) cannot appear;
//  * the crash guard — uncaught errors, unhandled rejections and the host's
//    liveness ping are marshalled back over the ONE `vscode` singleton.

import { vscode } from "@src/utils/vscode"

const createRoot = vi.fn((_container: Element) => ({ render: vi.fn() }))
vi.mock("react-dom/client", async () => {
	const actual = await vi.importActual<Record<string, unknown>>("react-dom/client")
	return { ...actual, createRoot: (...a: Parameters<typeof createRoot>) => createRoot(...a) }
})

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("../App", () => ({ default: () => <div data-testid="app" /> }))
vi.mock("../components/ErrorBoundary", () => ({ default: ({ children }: any) => <>{children}</> }))

const getHighlighter = vi.fn().mockResolvedValue({})
vi.mock("../utils/highlighter", () => ({ getHighlighter: () => getHighlighter() }))

const postMessage = vi.mocked(vscode.postMessage)
const globals = globalThis as unknown as Record<string, unknown>

// The entry does everything at import time, so what it did is recorded here —
// `beforeEach` clears the spies for the per-test assertions below.
let mountedInto: unknown
let warmedHighlighter = false

beforeAll(async () => {
	const root = document.createElement("div")
	root.id = "root"
	document.body.appendChild(root)
	await import("../index")
	mountedInto = createRoot.mock.calls[0]?.[0]
	warmedHighlighter = getHighlighter.mock.calls.length > 0
})

beforeEach(() => vi.clearAllMocks())

describe("the webview entry", () => {
	it("mounts the app into #root", () => {
		expect(mountedInto).toBe(document.getElementById("root"))
	})

	it("publishes one React instance for plugin bundles to share", () => {
		for (const key of [
			"__shoferHostReact",
			"__shoferHostReactDom",
			"__shoferHostReactDomClient",
			"__shoferHostJsxRuntime",
			"__shoferHostJsxDevRuntime",
			"__shoferPluginUi",
		]) {
			expect(globals[key]).toBeTruthy()
		}
	})

	it("warms the syntax highlighter", () => {
		expect(warmedHighlighter).toBe(true)
	})

	it("marshals an uncaught error back to the host", () => {
		window.dispatchEvent(new ErrorEvent("error", { message: "boom", filename: "a.js", lineno: 12, colno: 3 }))
		expect(postMessage).toHaveBeenCalledWith({
			type: "fatal_error",
			text: "Uncaught Error: boom at a.js:12:3",
		})
	})

	it("marshals an unhandled rejection, whatever the reason's shape", () => {
		const reject = (reason: unknown) =>
			window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }))

		reject(Object.assign(new Error("as an error"), { stack: "STACK" }))
		expect(postMessage).toHaveBeenCalledWith({
			type: "fatal_error",
			text: "Unhandled Promise Rejection: as an error\nSTACK",
		})

		reject("as a string")
		expect(postMessage).toHaveBeenCalledWith({
			type: "fatal_error",
			text: "Unhandled Promise Rejection: as a string",
		})

		reject({ code: 7 })
		expect(postMessage).toHaveBeenCalledWith({
			type: "fatal_error",
			text: 'Unhandled Promise Rejection: {"code":7}',
		})

		// A cyclic reason cannot be serialised; it still reaches the host.
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		reject(cyclic)
		expect(postMessage).toHaveBeenCalledWith({
			type: "fatal_error",
			text: "Unhandled Promise Rejection: [object Object]",
		})
	})

	it("answers the host's liveness ping and keeps a bounded ping history", async () => {
		const heartbeat = (window as unknown as { __shoferHeartbeat: Record<string, unknown> }).__shoferHeartbeat
		expect(heartbeat.pingCount).toBe(0)

		const ping = () =>
			new Promise<void>((resolve) => {
				window.postMessage({ type: "ping" }, "*")
				setTimeout(resolve, 0)
			})

		await ping()
		expect(heartbeat.pingCount).toBe(1)
		expect(heartbeat.pongCount).toBe(1)
		expect(postMessage).toHaveBeenCalledWith({ type: "pong" })

		for (let i = 0; i < 25; i++) await ping()
		expect((heartbeat.lastPingTimestamps as number[]).length).toBe(heartbeat.MAX_TIMESTAMPS)
	})

	it("ignores a message that is not a ping", async () => {
		const heartbeat = (window as unknown as { __shoferHeartbeat: { pingCount: number } }).__shoferHeartbeat
		const before = heartbeat.pingCount
		window.postMessage({ type: "state" }, "*")
		await new Promise((r) => setTimeout(r, 0))
		expect(heartbeat.pingCount).toBe(before)
	})
})
