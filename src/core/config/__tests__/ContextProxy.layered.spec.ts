// npx vitest core/config/__tests__/ContextProxy.layered.spec.ts
//
// Part E3: the additive, read-only layered `.shofer/settings.json` overlay in
// ContextProxy. These tests drive the real filesystem loader (real temp dirs)
// and assert the critical additive invariant: with no files, getValue is
// identical to globalState; with files, the merge engine's precedence
// (unlocked user-over-global, global-locked-wins, fail-closed on corruption)
// surfaces through getValue.

import fs from "fs/promises"
import * as path from "path"

import { ContextProxy } from "../ContextProxy"

vi.mock("vscode", () => ({
	Uri: {
		file: vi.fn((p) => ({ path: p })),
	},
	ExtensionMode: {
		Development: 1,
		Production: 2,
		Test: 3,
	},
	EventEmitter: class {
		event = () => () => {}
		fire = () => {}
		dispose = () => {}
	},
}))

// os.homedir() drives the user scope root; make it point at a per-test temp dir.
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

async function makeTmpDir(): Promise<string> {
	return fs.mkdtemp(path.join(TMP_BASE, "shofer-layered-"))
}

async function writeSettings(scopeDir: string, obj: unknown): Promise<void> {
	await fs.mkdir(scopeDir, { recursive: true })
	await fs.writeFile(path.join(scopeDir, "settings.json"), JSON.stringify(obj))
}

async function writeRaw(scopeDir: string, file: string, contents: string): Promise<void> {
	await fs.mkdir(scopeDir, { recursive: true })
	await fs.writeFile(path.join(scopeDir, file), contents)
}

describe("ContextProxy — layered .shofer overlay (Part E3)", () => {
	let mockContext: any
	let mockGlobalState: any
	let mockSecrets: any
	const createdDirs: string[] = []
	const savedGlobalDir = process.env.SHOFER_GLOBAL_DIR

	beforeEach(() => {
		vi.clearAllMocks()
		delete process.env.SHOFER_GLOBAL_DIR
		hoisted.home = "/nonexistent-home"

		mockGlobalState = {
			get: vi.fn(),
			update: vi.fn().mockResolvedValue(undefined),
		}
		mockSecrets = {
			get: vi.fn().mockResolvedValue(undefined),
			store: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn().mockResolvedValue(undefined),
		}
		mockContext = {
			globalState: mockGlobalState,
			secrets: mockSecrets,
			extensionUri: { path: "/test/extension" },
			extensionPath: "/test/extension",
			// fsPath intentionally points at a non-existent dir: the standalone
			// global-storage `.shofer/` default resolves to an empty scope.
			globalStorageUri: { fsPath: "/nonexistent-global-storage" },
			logUri: { path: "/test/logs" },
			extension: { packageJSON: { version: "1.0.0" } },
			extensionMode: 1,
		}
	})

	afterEach(async () => {
		if (savedGlobalDir === undefined) {
			delete process.env.SHOFER_GLOBAL_DIR
		} else {
			process.env.SHOFER_GLOBAL_DIR = savedGlobalDir
		}
		await Promise.all(createdDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
	})

	async function tmpDir(): Promise<string> {
		const dir = await makeTmpDir()
		createdDirs.push(dir)
		return dir
	}

	it("(a) no .shofer files anywhere → getValue is identical to globalState", async () => {
		// homedir points at a dir with no `.shofer/settings.json`; no global dir;
		// no workspace. The overlay is empty → pure globalState fallback.
		hoisted.home = await tmpDir()

		const proxy = new ContextProxy(mockContext)
		await proxy.initialize()

		// Cache-backed read matches what globalState holds.
		await proxy.updateGlobalState("writeDelayMs", 777)
		expect(proxy.getValue("writeDelayMs")).toBe(777)

		// An unset key returns the globalState value (undefined) unchanged.
		expect(proxy.getValue("autoApprovalEnabled")).toBe(proxy.getGlobalState("autoApprovalEnabled"))
	})

	it("(b) a user .shofer/settings.json overrides an unlocked key over global", async () => {
		const globalDir = await tmpDir()
		const homeDir = await tmpDir()
		hoisted.home = homeDir
		process.env.SHOFER_GLOBAL_DIR = globalDir

		await writeSettings(globalDir, { writeDelayMs: 100 })
		await writeSettings(path.join(homeDir, ".shofer"), { writeDelayMs: 200 })

		const proxy = new ContextProxy(mockContext)
		await proxy.initialize()

		// Unlocked: user (more specific) wins over global default.
		expect(proxy.getValue("writeDelayMs")).toBe(200)
	})

	it("(c) a global-locked key beats a user override", async () => {
		const globalDir = await tmpDir()
		const homeDir = await tmpDir()
		hoisted.home = homeDir
		process.env.SHOFER_GLOBAL_DIR = globalDir

		await writeSettings(globalDir, { writeDelayMs: 100 })
		await writeRaw(globalDir, "locked.json", JSON.stringify({ version: 1, locked: ["writeDelayMs"] }))
		await writeSettings(path.join(homeDir, ".shofer"), { writeDelayMs: 200 })

		const proxy = new ContextProxy(mockContext)
		await proxy.initialize()

		// Locked: the global value is final and the user override is dropped.
		expect(proxy.getValue("writeDelayMs")).toBe(100)
	})

	it("(d) a corrupt settings.json is ignored (fail closed to globalState)", async () => {
		const homeDir = await tmpDir()
		hoisted.home = homeDir
		await writeRaw(path.join(homeDir, ".shofer"), "settings.json", "{ this is not valid json")

		const proxy = new ContextProxy(mockContext)
		await proxy.initialize()

		// Corrupt file contributes nothing → overlay empty → globalState wins.
		await proxy.updateGlobalState("writeDelayMs", 999)
		expect(proxy.getValue("writeDelayMs")).toBe(999)
	})

	it("(e) getValues() resolves the overlay too, so bulk readers agree with getValue", async () => {
		// Not a cosmetic consistency point: `NodeRegistry.currentSyncedSlice()` builds the
		// controller→node config slice from getValues(), so an overlay-only value that this
		// snapshot omitted would reach the IDE and never reach the pool — file-based
		// settings would silently stop at the controller.
		const homeDir = await tmpDir()
		hoisted.home = homeDir
		await writeSettings(path.join(homeDir, ".shofer"), { writeDelayMs: 321 })

		const proxy = new ContextProxy(mockContext)
		await proxy.initialize()
		await proxy.updateGlobalState("writeDelayMs", 999)

		expect(proxy.getValues().writeDelayMs).toBe(321)
		expect(proxy.getValues().writeDelayMs).toBe(proxy.getValue("writeDelayMs"))
	})
})
