import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { ScopeWatcher } from "../scopeWatcher"

vi.mock("@shofer/core", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		configLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	}
})

/**
 * The scope watcher is what makes "write the file, the fleet converges" true
 * (docs/workspace_agent_pool.md §5), so these tests exercise the two write shapes that
 * actually occur — an atomic temp-file rename (how `writeScopeSetting` and most editors
 * save) and a Kubernetes ConfigMap `..data` symlink swap — plus the case that used to
 * silently produce a dead watcher: a scope root that does not exist yet.
 */
describe("ScopeWatcher", () => {
	let tmp: string
	const watchers: ScopeWatcher[] = []

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shofer-scopewatch-"))
	})

	afterEach(() => {
		for (const watcher of watchers.splice(0)) {
			watcher.dispose()
		}
		fs.rmSync(tmp, { recursive: true, force: true })
	})

	/** Resolve when `onChange` has fired, or reject after `timeoutMs`. */
	const nextChange = (options: { roots: Parameters<typeof makeWatcher>[0]; timeoutMs?: number }) =>
		new Promise<string[]>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("watcher did not fire")), options.timeoutMs ?? 4000)
			makeWatcher(options.roots, (files) => {
				clearTimeout(timer)
				resolve(files)
			})
		})

	function makeWatcher(roots: { global?: string; user?: string; project?: string }, onChange: (f: string[]) => void) {
		const watcher = new ScopeWatcher({
			roots,
			files: ["settings.json", "locked.json"],
			onChange,
			debounceMs: 10,
			retryMs: 50,
		})
		watchers.push(watcher)
		return watcher
	}

	it("fires when settings.json is replaced by an atomic rename", async () => {
		const root = path.join(tmp, "user", ".shofer")
		fs.mkdirSync(root, { recursive: true })
		fs.writeFileSync(path.join(root, "settings.json"), "{}")

		const fired = nextChange({ roots: { user: root } })
		// Exactly what writeScopeSetting does: write a temp file, rename over the target.
		const tmpFile = path.join(root, "settings.json.tmp-1")
		fs.writeFileSync(tmpFile, JSON.stringify({ alwaysAllowWrite: true }))
		fs.renameSync(tmpFile, path.join(root, "settings.json"))

		await expect(fired).resolves.toContain("settings.json")
	})

	it("fires on a ConfigMap-style `..data` symlink swap, which names no watched file", async () => {
		// Reproduce a kubelet projected-volume update: the real content lives in a
		// timestamped directory, `..data` symlinks to it, and each entry symlinks through
		// `..data`. An update builds a new directory and swaps `..data` atomically — no
		// event ever names `settings.json`.
		const root = path.join(tmp, "global", ".shofer")
		const v1 = path.join(root, "..2026_01_01")
		fs.mkdirSync(v1, { recursive: true })
		fs.writeFileSync(path.join(v1, "settings.json"), "{}")
		fs.symlinkSync(v1, path.join(root, "..data"))
		fs.symlinkSync(path.join("..data", "settings.json"), path.join(root, "settings.json"))

		const fired = nextChange({ roots: { global: root } })

		const v2 = path.join(root, "..2026_01_02")
		fs.mkdirSync(v2)
		fs.writeFileSync(path.join(v2, "settings.json"), JSON.stringify({ alwaysAllowWrite: true }))
		const stagedLink = path.join(root, "..data_tmp")
		fs.symlinkSync(v2, stagedLink)
		fs.renameSync(stagedLink, path.join(root, "..data"))

		// The caller is told to re-read everything, since the event identifies nothing.
		await expect(fired).resolves.toEqual(expect.arrayContaining(["settings.json", "locked.json"]))
	})

	it("picks up a scope root that is created after the watcher starts", async () => {
		const root = path.join(tmp, "late", ".shofer")

		const fired = nextChange({ roots: { user: root } })
		fs.mkdirSync(root, { recursive: true })
		fs.writeFileSync(path.join(root, "settings.json"), "{}")

		await expect(fired).resolves.toContain("settings.json")
	})

	it("ignores an unrelated file in a watched scope", async () => {
		const root = path.join(tmp, "quiet", ".shofer")
		fs.mkdirSync(root, { recursive: true })

		const onChange = vi.fn()
		makeWatcher({ user: root }, onChange)
		fs.writeFileSync(path.join(root, "notes.md"), "hello")

		await new Promise((resolve) => setTimeout(resolve, 300))
		expect(onChange).not.toHaveBeenCalled()
	})

	it("collapses a burst of writes into one callback", async () => {
		const root = path.join(tmp, "burst", ".shofer")
		fs.mkdirSync(root, { recursive: true })

		const onChange = vi.fn()
		makeWatcher({ user: root }, onChange)
		for (let i = 0; i < 5; i++) {
			fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ i }))
		}

		await new Promise((resolve) => setTimeout(resolve, 300))
		expect(onChange).toHaveBeenCalledTimes(1)
	})

	it("stops firing once disposed", async () => {
		const root = path.join(tmp, "disposed", ".shofer")
		fs.mkdirSync(root, { recursive: true })

		const onChange = vi.fn()
		const watcher = makeWatcher({ user: root }, onChange)
		watcher.dispose()
		fs.writeFileSync(path.join(root, "settings.json"), "{}")

		await new Promise((resolve) => setTimeout(resolve, 300))
		expect(onChange).not.toHaveBeenCalled()
	})

	it("survives a scope root that can never exist", async () => {
		const onChange = vi.fn()
		expect(() => makeWatcher({ global: path.join(tmp, "nope", ".shofer") }, onChange)).not.toThrow()
		await new Promise((resolve) => setTimeout(resolve, 150))
		expect(onChange).not.toHaveBeenCalled()
	})
})
