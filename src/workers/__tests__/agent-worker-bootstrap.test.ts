// npx vitest src/workers/__tests__/agent-worker-bootstrap.test.ts

/**
 * `bootstrapAgentWorker` loads the SAME `dist/extension.js` bundle inside a
 * worker thread — the Headless Hosts Run The Extension Rule in its most literal
 * form. Everything it does is about making `require("vscode")` resolve to the
 * shim before the bundle is loaded, and the invariant worth pinning is that the
 * `Module._resolveFilename` patch is RESTORED on both paths: leaving it in place
 * after a failed load poisons every later `require` in the worker, and the
 * symptom is an unrelated module resolving to the vscode mock.
 */

const hoisted = vi.hoisted(() => ({
	createVSCodeAPIMock: vi.fn(() => ({ context: { marker: "shim-context" } })),
	markWebviewReady: vi.fn(),
	hostArgs: [] as unknown[][],
	activate: vi.fn(async () => ({ api: true })),
	loadThrows: false,
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
	existsSync: vi.fn(() => false),
	requiredPaths: [] as string[],
	patchedDuringLoad: undefined as undefined | ((r: string, p: unknown, m: boolean, o: unknown) => string),
}))

vi.mock("@shofer/vscode-shim", () => ({ createVSCodeAPIMock: hoisted.createVSCodeAPIMock }))

vi.mock("../worker-extension-host.js", () => ({
	WorkerExtensionHost: class {
		markWebviewReady = hoisted.markWebviewReady
		constructor(...args: unknown[]) {
			hoisted.hostArgs.push(args)
		}
	},
}))

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>()
	const api = {
		...actual,
		mkdirSync: hoisted.mkdirSync,
		writeFileSync: hoisted.writeFileSync,
		existsSync: hoisted.existsSync,
	}
	return { ...api, default: api }
})

vi.mock("module", async (importOriginal) => {
	const actual = await importOriginal<typeof import("module")>()
	const createRequire = () => {
		const fake = ((request: string) => {
			if (request === "module") return fakeModule
			hoisted.requiredPaths.push(request)
			// The patch is installed only for the duration of this require, so this
			// is the one moment a test can observe it.
			hoisted.patchedDuringLoad = fakeModule._resolveFilename as never
			if (hoisted.loadThrows) throw new Error("bundle missing")
			return { activate: hoisted.activate }
		}) as unknown as NodeJS.Require
		return fake
	}
	return { ...actual, default: { ...actual, createRequire }, createRequire }
})

/** Stand-in for Node's `module` builtin, so the resolver patch is observable. */
const originalResolve = vi.fn((request: string) => `/resolved/${request}`)
const fakeModule = { _resolveFilename: originalResolve as unknown as (...args: unknown[]) => string }

import { bootstrapAgentWorker, type AgentWorkerData } from "../agent-worker"

const data: AgentWorkerData = {
	taskId: "task-1",
	cwd: "/workspace",
	extensionPath: "/ext",
	settings: { mode: "code" },
}

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.hostArgs = []
	hoisted.requiredPaths = []
	hoisted.loadThrows = false
	hoisted.existsSync.mockReturnValue(false)
	hoisted.activate.mockResolvedValue({ api: true })
	fakeModule._resolveFilename = originalResolve as unknown as (...args: unknown[]) => string
})

describe("bootstrapAgentWorker", () => {
	it("activates the bundle with the SHIM's context and returns the api", async () => {
		await expect(bootstrapAgentWorker(data)).resolves.toEqual({ taskId: "task-1", api: { api: true } })

		expect(hoisted.activate).toHaveBeenCalledWith({ marker: "shim-context" })
		expect(hoisted.requiredPaths).toContain("/ext/dist/extension.js")
	})

	it("builds the shim against the worker's own extension path and cwd", async () => {
		await bootstrapAgentWorker(data)

		expect(hoisted.createVSCodeAPIMock).toHaveBeenCalledWith(
			"/ext",
			"/workspace",
			undefined,
			expect.objectContaining({ extensionHost: expect.anything() }),
		)
	})

	it("gives the extension host a no-op UI port until one is transferred", async () => {
		await bootstrapAgentWorker(data)

		const [port] = hoisted.hostArgs[0] as [{ postMessage: () => void; on: () => void }]
		expect(() => port.postMessage()).not.toThrow()
		expect(() => port.on()).not.toThrow()
	})

	it("marks the webview ready, which is what starts the headless turn loop", async () => {
		await bootstrapAgentWorker(data)

		expect(hoisted.markWebviewReady).toHaveBeenCalled()
	})

	it("RESTORES the resolver after a successful load", async () => {
		await bootstrapAgentWorker(data)

		expect(fakeModule._resolveFilename).toBe(originalResolve)
	})

	it("RESTORES the resolver after a FAILED load, and names the task in the error", async () => {
		hoisted.loadThrows = true

		await expect(bootstrapAgentWorker(data)).rejects.toThrow(
			/\[agent-worker task-1\] Failed to load extension bundle: bundle missing/,
		)
		expect(fakeModule._resolveFilename).toBe(originalResolve)
	})

	it("names the task when activation itself fails", async () => {
		hoisted.activate.mockRejectedValueOnce(new Error("no provider"))

		await expect(bootstrapAgentWorker(data)).rejects.toThrow(
			/\[agent-worker task-1\] Failed to activate extension: no provider/,
		)
	})

	it("labels a non-Error activation failure", async () => {
		hoisted.activate.mockRejectedValueOnce("boom")

		await expect(bootstrapAgentWorker(data)).rejects.toThrow(/Failed to activate extension: boom/)
	})
})

describe("the require('vscode') interception", () => {
	/** The resolver as patched, captured while the bundle was being required. */
	async function capturePatchedResolver() {
		hoisted.patchedDuringLoad = undefined
		await bootstrapAgentWorker(data)
		expect(hoisted.patchedDuringLoad).toBeDefined()
		return hoisted.patchedDuringLoad!
	}

	it("redirects only 'vscode', delegating every other request to the original resolver", async () => {
		const patched = await capturePatchedResolver()

		expect(patched("vscode", null, false, null)).toBe("/workspace/.shofer/tmp/vscode-mock.js")
		expect(patched("path", null, false, null)).toBe("/resolved/path")
	})

	it("writes the on-disk mock shim once, and reuses it thereafter", async () => {
		const patched = await capturePatchedResolver()

		patched("vscode", null, false, null)
		expect(hoisted.mkdirSync).toHaveBeenCalledWith("/workspace/.shofer/tmp", { recursive: true })
		const [, contents] = hoisted.writeFileSync.mock.calls[0] as [string, string]
		expect(contents).toContain("module.exports = g.vscode")
		expect(contents).toContain("global.vscode not set before vscode-mock load")

		hoisted.existsSync.mockReturnValue(true)
		hoisted.writeFileSync.mockClear()
		patched("vscode", null, false, null)
		expect(hoisted.writeFileSync).not.toHaveBeenCalled()
	})
})
