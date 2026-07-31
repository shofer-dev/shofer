// npx vitest core/config/__tests__/ContextProxy.write.spec.ts
//
// The scope-aware write-through in ContextProxy.setValue. A
// globalSettings write is mirrored unconditionally into the user scope's
// `~/.shofer/settings.json` (created on first write), so the file
// layer is authoritative and getValue reflects it through the E3 overlay. A
// key the global scope locks is not persisted and its effective value is
// unchanged. These tests drive the real filesystem loader/writer against per-test
// temp dirs (os.homedir mocked), mirroring ContextProxy.layered.spec.ts.

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

// getWorkspacePath() drives the project scope root; per-test override.
const wsHoisted = vi.hoisted(() => ({ ws: "" }))
vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	getWorkspacePath: () => wsHoisted.ws,
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
	return fs.mkdtemp(path.join(TMP_BASE, "shofer-write-"))
}

async function writeSettings(scopeDir: string, obj: unknown): Promise<void> {
	await fs.mkdir(scopeDir, { recursive: true })
	await fs.writeFile(path.join(scopeDir, "settings.json"), JSON.stringify(obj))
}

async function writeRaw(scopeDir: string, file: string, contents: string): Promise<void> {
	await fs.mkdir(scopeDir, { recursive: true })
	await fs.writeFile(path.join(scopeDir, file), contents)
}

async function readUserSettings(homeDir: string): Promise<Record<string, unknown>> {
	const raw = await fs.readFile(path.join(homeDir, ".shofer", "settings.json"), "utf8")
	return JSON.parse(raw)
}

describe("ContextProxy — scope-aware write-through (Part E4)", () => {
	let mockContext: any
	let mockGlobalState: any
	let mockSecrets: any
	const createdDirs: string[] = []
	const savedGlobalDir = process.env.SHOFER_GLOBAL_DIR

	beforeEach(() => {
		vi.clearAllMocks()
		delete process.env.SHOFER_GLOBAL_DIR
		hoisted.home = "/nonexistent-home"
		wsHoisted.ws = ""

		const store: Record<string, unknown> = {}
		mockGlobalState = {
			get: vi.fn((key: string) => store[key]),
			update: vi.fn((key: string, value: unknown) => {
				store[key] = value
				return Promise.resolve()
			}),
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

	it("(a) setValue mirrors a globalSettings key into ~/.shofer/settings.json and getValue reflects it via the overlay", async () => {
		const homeDir = await tmpDir()
		hoisted.home = homeDir
		// No pre-existing user file: the first write creates it.

		const proxy = new ContextProxy(mockContext)
		await proxy.initialize()

		await proxy.setValue("writeDelayMs", 555)

		// Persisted to the user file...
		const onDisk = await readUserSettings(homeDir)
		expect(onDisk.writeDelayMs).toBe(555)

		// ...and surfaced through the layered overlay on read.
		expect(proxy.getValue("writeDelayMs")).toBe(555)
	})

	it("(a') initialize seeds ~/.shofer/settings.json from pre-existing globalState values", async () => {
		const homeDir = await tmpDir()
		hoisted.home = homeDir

		// A value that predates the file layer, resident only in globalState.
		mockGlobalState.get.mockImplementation((key: string) => (key === "writeDelayMs" ? 777 : undefined))

		const proxy = new ContextProxy(mockContext)
		await proxy.initialize()

		// The one-time seed materialized it into the user file...
		const onDisk = await readUserSettings(homeDir)
		expect(onDisk.writeDelayMs).toBe(777)
		// ...and the overlay serves it.
		expect(proxy.getValue("writeDelayMs")).toBe(777)
	})

	it("(a'') the seed never overwrites an existing settings file", async () => {
		const homeDir = await tmpDir()
		hoisted.home = homeDir
		await writeSettings(path.join(homeDir, ".shofer"), { writeDelayMs: 111 })

		mockGlobalState.get.mockImplementation((key: string) => (key === "writeDelayMs" ? 777 : undefined))

		const proxy = new ContextProxy(mockContext)
		await proxy.initialize()

		const onDisk = await readUserSettings(homeDir)
		expect(onDisk.writeDelayMs).toBe(111)
	})

	it("(b) writing a global-locked key does not change the effective value and is not persisted to the user file", async () => {
		const globalDir = await tmpDir()
		const homeDir = await tmpDir()
		hoisted.home = homeDir
		process.env.SHOFER_GLOBAL_DIR = globalDir

		await writeSettings(globalDir, { writeDelayMs: 100 })
		await writeRaw(globalDir, "locked.json", JSON.stringify({ version: 1, locked: ["writeDelayMs"] }))
		// A user file exists (so its absence cannot explain the missing key below).
		await writeSettings(path.join(homeDir, ".shofer"), {})

		const proxy = new ContextProxy(mockContext)
		await proxy.initialize()

		await proxy.setValue("writeDelayMs", 999)

		// The locked global value stays final on read.
		expect(proxy.getValue("writeDelayMs")).toBe(100)

		// The user file was NOT given a shadowed entry for the locked key.
		const onDisk = await readUserSettings(homeDir)
		expect(onDisk).not.toHaveProperty("writeDelayMs")
	})

	it("(b') settingsWriteScope routes writes to the project scope; the selector itself stays user-scoped", async () => {
		const homeDir = await tmpDir()
		const wsDir = await tmpDir()
		hoisted.home = homeDir
		wsHoisted.ws = wsDir

		const proxy = new ContextProxy(mockContext)
		await proxy.initialize()

		// Selecting the project scope persists the selector at the USER scope —
		// routing it into the project file would commit one user's preference.
		await proxy.setValue("settingsWriteScope", "project")
		const userFile = await readUserSettings(homeDir)
		expect(userFile.settingsWriteScope).toBe("project")

		// Subsequent writes land in the workspace's .shofer/settings.json.
		await proxy.setValue("writeDelayMs", 42)
		const projectFile = JSON.parse(await fs.readFile(path.join(wsDir, ".shofer", "settings.json"), "utf8"))
		expect(projectFile.writeDelayMs).toBe(42)
		expect((await readUserSettings(homeDir)).writeDelayMs).toBeUndefined()

		// And the overlay serves the project value.
		expect(proxy.getValue("writeDelayMs")).toBe(42)
	})

	it("(c) a bulk setValues does not lose keys to a read-modify-write race", async () => {
		const homeDir = await tmpDir()
		hoisted.home = homeDir

		const proxy = new ContextProxy(mockContext)
		await proxy.initialize()

		// setValues fans out to concurrent setValue calls; the per-file write lock
		// must serialize the read-modify-writes so every key survives.
		await proxy.setValues({ writeDelayMs: 10, mode: "code", autoApprovalEnabled: true })

		const onDisk = await readUserSettings(homeDir)
		expect(onDisk.writeDelayMs).toBe(10)
		expect(onDisk.mode).toBe("code")
		expect(onDisk.autoApprovalEnabled).toBe(true)
	})
})
