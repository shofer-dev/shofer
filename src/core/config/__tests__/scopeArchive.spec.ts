// npx vitest core/config/__tests__/scopeArchive.spec.ts
//
// Part E5: export/import = archive a scope's `.shofer/` tree. Drives the real
// tar-backed archiver (packages/core/src/config/scope-archive.ts) through the
// host wrappers in importExport.ts against per-test temp dirs, asserting the
// round-trip and — critically — that the archive carries `settings.json` but NO
// secret material (secrets live in SecretStorage, never under `.shofer/`).

import fs from "fs/promises"
import * as path from "path"

import { listScopeArchiveEntries } from "@shofer/core"

import { exportScopeSettingsArchive, importScopeSettingsArchive } from "../importExport"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({ get: vi.fn() }),
	},
	window: {
		showOpenDialog: vi.fn(),
		showSaveDialog: vi.fn(),
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
	},
	Uri: {
		file: vi.fn((p) => ({ fsPath: p, path: p })),
	},
	ExtensionMode: { Development: 1, Production: 2, Test: 3 },
	EventEmitter: class {
		event = () => () => {}
		fire = () => {}
		dispose = () => {}
	},
}))

const TMP_BASE = process.env.TMPDIR || "/tmp"
const createdDirs: string[] = []

async function tmpDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(TMP_BASE, prefix))
	createdDirs.push(dir)
	return dir
}

afterEach(async () => {
	await Promise.all(createdDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

describe("scope archive export/import (Part E5)", () => {
	it("round-trips a scope's .shofer/ and includes settings.json with no secret material", async () => {
		// A source scope `.shofer/` with a settings.json that references a provider
		// profile BY NAME only (no apiKey), plus a rules file — the sort of tree a
		// non-secret bundle carries.
		const srcScope = await tmpDir("shofer-arc-src-")
		await fs.writeFile(
			path.join(srcScope, "settings.json"),
			JSON.stringify({ currentApiConfigName: "default", mode: "code", writeDelayMs: 250 }, null, 2),
		)
		await fs.mkdir(path.join(srcScope, "rules"), { recursive: true })
		await fs.writeFile(path.join(srcScope, "rules", "01-style.md"), "# style rules\n")

		const workDir = await tmpDir("shofer-arc-out-")
		const archivePath = path.join(workDir, "nested", "bundle.tar.gz")

		await exportScopeSettingsArchive(archivePath, srcScope)

		// Archive exists and carries settings.json + the rules file.
		await expect(fs.access(archivePath)).resolves.toBeUndefined()
		const entries = await listScopeArchiveEntries(archivePath)
		expect(entries).toContain("settings.json")
		expect(entries.some((e) => e.endsWith("01-style.md"))).toBe(true)

		// No secret material: no SecretStorage blob/keys, and settings.json holds no
		// inline credential (it references the profile by name only).
		expect(entries.some((e) => /secret|\.vscdb|api[_-]?key/i.test(e))).toBe(false)

		// Import into a fresh scope root and confirm the round-trip.
		const dstScope = await tmpDir("shofer-arc-dst-")
		await importScopeSettingsArchive(archivePath, dstScope)

		const restored = JSON.parse(await fs.readFile(path.join(dstScope, "settings.json"), "utf8"))
		expect(restored).toEqual({ currentApiConfigName: "default", mode: "code", writeDelayMs: 250 })
		expect(restored).not.toHaveProperty("apiKey")

		const restoredRule = await fs.readFile(path.join(dstScope, "rules", "01-style.md"), "utf8")
		expect(restoredRule).toBe("# style rules\n")
	})
})
