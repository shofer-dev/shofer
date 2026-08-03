// npx vitest core/config/__tests__/ContextProxy.watcher.spec.ts
//
// The live half of the layered overlay (see docs/settings_overlay.md): a `.shofer/`
// file edited by someone OTHER than this host — another pod on the shared volume, a
// ConfigMap rewrite, a person with an editor — must change this host's effective
// settings without a restart. These tests drive real temp dirs and the real watcher,
// because the thing under test is precisely whether a filesystem event arrives.

import fs from "fs/promises"
import * as path from "path"

import { ContextProxy } from "../ContextProxy"

vi.mock("vscode", () => ({
	Uri: { file: vi.fn((p) => ({ path: p })) },
	ExtensionMode: { Development: 1, Production: 2, Test: 3 },
	EventEmitter: class {
		event = () => () => {}
		fire = () => {}
		dispose = () => {}
	},
}))

const hoisted = vi.hoisted(() => ({ home: "/nonexistent-home" }))
vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>()
	return {
		...actual,
		default: { ...actual, homedir: () => hoisted.home },
		homedir: () => hoisted.home,
	}
})

const TMP_BASE = process.env.TMPDIR || "/tmp"

/** Wait for `predicate` to hold, polling — the watcher's latency is the OS's, not ours. */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
	throw new Error("condition not met before timeout")
}

describe("ContextProxy — live `.shofer/` scope watching", () => {
	let mockContext: any
	const createdDirs: string[] = []
	const proxies: ContextProxy[] = []
	const savedGlobalDir = process.env.SHOFER_GLOBAL_DIR

	beforeEach(() => {
		vi.clearAllMocks()
		delete process.env.SHOFER_GLOBAL_DIR
		hoisted.home = "/nonexistent-home"
		mockContext = {
			globalState: { get: vi.fn(), update: vi.fn().mockResolvedValue(undefined) },
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			extensionUri: { path: "/test/extension" },
			extensionPath: "/test/extension",
			globalStorageUri: { fsPath: "/nonexistent-global-storage" },
			logUri: { path: "/test/logs" },
			extension: { packageJSON: { version: "1.0.0" } },
			extensionMode: 1,
		}
	})

	afterEach(async () => {
		for (const proxy of proxies.splice(0)) proxy.dispose()
		if (savedGlobalDir === undefined) delete process.env.SHOFER_GLOBAL_DIR
		else process.env.SHOFER_GLOBAL_DIR = savedGlobalDir
		await Promise.all(createdDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
	})

	async function tmpDir(): Promise<string> {
		const dir = await fs.mkdtemp(path.join(TMP_BASE, "shofer-watch-"))
		createdDirs.push(dir)
		return dir
	}

	async function writeSettings(scopeDir: string, obj: unknown): Promise<void> {
		await fs.mkdir(scopeDir, { recursive: true })
		const tmp = path.join(scopeDir, `settings.json.tmp-${Math.random().toString(36).slice(2)}`)
		await fs.writeFile(tmp, JSON.stringify(obj))
		await fs.rename(tmp, path.join(scopeDir, "settings.json"))
	}

	async function makeProxy(): Promise<ContextProxy> {
		const proxy = new ContextProxy(mockContext)
		await proxy.initialize()
		proxy.startScopeWatcher()
		proxies.push(proxy)
		return proxy
	}

	it("applies an external edit to the user scope with no restart", async () => {
		const homeDir = await tmpDir()
		hoisted.home = homeDir
		await writeSettings(path.join(homeDir, ".shofer"), { writeDelayMs: 100 })

		const proxy = await makeProxy()
		expect(proxy.getValue("writeDelayMs")).toBe(100)

		// Someone else rewrites the file (another pod, an editor, resource-manager).
		await writeSettings(path.join(homeDir, ".shofer"), { writeDelayMs: 250 })

		await waitFor(() => proxy.getValue("writeDelayMs") === 250)
	})

	it("announces exactly the keys that changed, on both events", async () => {
		const homeDir = await tmpDir()
		hoisted.home = homeDir
		await writeSettings(path.join(homeDir, ".shofer"), { writeDelayMs: 100, alwaysAllowWrite: true })

		const proxy = await makeProxy()
		const changedKeys: string[] = []
		const refreshes: string[][] = []
		proxy.onDidChange(({ key }) => changedKeys.push(key))
		proxy.onDidRefreshOverlay(({ keys }) => refreshes.push(keys))

		await writeSettings(path.join(homeDir, ".shofer"), { writeDelayMs: 999, alwaysAllowWrite: true })

		await waitFor(() => refreshes.length > 0)
		// `alwaysAllowWrite` was rewritten with the same value — an unchanged key is not
		// a change, or every node would re-broadcast its whole config on every touch.
		expect(refreshes[0]).toEqual(["writeDelayMs"])
		expect(changedKeys).toEqual(["writeDelayMs"])
	})

	it("stays silent when a rewrite changes nothing", async () => {
		const homeDir = await tmpDir()
		hoisted.home = homeDir
		await writeSettings(path.join(homeDir, ".shofer"), { writeDelayMs: 100 })

		const proxy = await makeProxy()
		const refreshes: string[][] = []
		proxy.onDidRefreshOverlay(({ keys }) => refreshes.push(keys))

		await writeSettings(path.join(homeDir, ".shofer"), { writeDelayMs: 100 })
		await new Promise((resolve) => setTimeout(resolve, 400))

		expect(refreshes).toEqual([])
	})

	it("picks up a global-scope (ConfigMap) rewrite, and its lock manifest", async () => {
		const globalDir = await tmpDir()
		const homeDir = await tmpDir()
		hoisted.home = homeDir
		process.env.SHOFER_GLOBAL_DIR = globalDir
		await writeSettings(globalDir, { writeDelayMs: 10 })
		await writeSettings(path.join(homeDir, ".shofer"), { writeDelayMs: 20 })

		const proxy = await makeProxy()
		// Unlocked: the user's value wins.
		expect(proxy.getValue("writeDelayMs")).toBe(20)

		// The platform locks the key — the global value must take over live, because a
		// policy that only applies after a restart is not a policy.
		await fs.writeFile(
			path.join(globalDir, "locked.json"),
			JSON.stringify({ version: 1, locked: ["writeDelayMs"] }),
		)

		await waitFor(() => proxy.getValue("writeDelayMs") === 10)
	})

	it("keeps the last good values when a scope file is corrupted", async () => {
		const homeDir = await tmpDir()
		hoisted.home = homeDir
		await writeSettings(path.join(homeDir, ".shofer"), { writeDelayMs: 42 })
		const proxy = await makeProxy()
		expect(proxy.getValue("writeDelayMs")).toBe(42)

		// Schema-First: a corrupt scope contributes nothing, so the effective value falls
		// back to globalState rather than to garbage.
		await fs.writeFile(path.join(homeDir, ".shofer", "settings.json"), "{ not json")

		await waitFor(() => proxy.getValue("writeDelayMs") === undefined)
	})

	it("does not watch anything until startScopeWatcher is called", async () => {
		const homeDir = await tmpDir()
		hoisted.home = homeDir
		await writeSettings(path.join(homeDir, ".shofer"), { writeDelayMs: 1 })

		const proxy = new ContextProxy(mockContext)
		await proxy.initialize()
		proxies.push(proxy)

		await writeSettings(path.join(homeDir, ".shofer"), { writeDelayMs: 2 })
		await new Promise((resolve) => setTimeout(resolve, 400))

		expect(proxy.getValue("writeDelayMs")).toBe(1)
	})
})
