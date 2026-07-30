// Catalogue: the manifest ↔ runtime sync (contributes.modes must equal DETECTOR_MODES,
// so the declarative contribution and the code cannot drift), the layering of
// .shofer/second-brain/catalogue.json over the bundled defaults, the fail-closed parse,
// and the pilot fallback chain.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { CATALOGUE_DEFAULTS, DETECTOR_MODES } from "../src/detectors.js"
import { expandModeGrant, loadCatalogue, pickPilot } from "../src/catalogue.js"

const here = dirname(fileURLToPath(import.meta.url))

const missing = async () => {
	throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
}

describe("manifest ↔ detectors sync", () => {
	it("plugin.json contributes.modes equals DETECTOR_MODES exactly", () => {
		const manifest = JSON.parse(readFileSync(join(here, "..", "plugin.json"), "utf8")) as {
			contributes: { modes: unknown[] }
		}
		expect(manifest.contributes.modes).toEqual(JSON.parse(JSON.stringify(DETECTOR_MODES)))
	})

	it("every mode has a catalogue default and vice versa", () => {
		expect(new Set(DETECTOR_MODES.map((m) => m.slug))).toEqual(new Set(Object.keys(CATALOGUE_DEFAULTS)))
	})

	it("every mode is private — a detector leaking into a picker would be a bug", () => {
		for (const mode of DETECTOR_MODES) expect(mode.private).toBe(true)
	})
})

describe("loadCatalogue", () => {
	it("no override file ⇒ the bundled defaults, with mode grants expanded", async () => {
		const defs = await loadCatalogue(missing)
		const bySlug = Object.fromEntries(defs.map((d) => [d.slug, d]))
		expect(bySlug["repeat-failure"]!.enabled).toBe(true)
		expect(bySlug["repeat-failure"]!.pilot).toBe(true)
		expect(bySlug["repeat-failure"]!.tools).toEqual([])
		expect(bySlug["default"]!.tools).toEqual(
			expect.arrayContaining(["read_file", "grep_search", "list_files", "find_files"]),
		)
		expect(bySlug["static-analysis"]!.enabled).toBe(false)
		expect(bySlug["static-analysis"]!.exec).toEqual([]) // ships EMPTY by design
		expect(bySlug["git-log"]!.exec).toContain("git status --short")
		expect(bySlug["cross-task-collision"]!.structural).toBe(true)
	})

	it("workspace overrides shadow defaults per field, keyed by slug", async () => {
		const defs = await loadCatalogue(async () =>
			JSON.stringify({
				"static-analysis": { enabled: true, exec: ["go build ./..."], deadlineS: 60 },
				"standard-questions": { config: { questions: [{ key: "x", ask: "X done?" }] } },
				default: { system: "custom watcher prompt" },
			}),
		)
		const bySlug = Object.fromEntries(defs.map((d) => [d.slug, d]))
		expect(bySlug["static-analysis"]!.enabled).toBe(true)
		expect(bySlug["static-analysis"]!.exec).toEqual(["go build ./..."])
		expect(bySlug["static-analysis"]!.deadlineS).toBe(60)
		expect(bySlug["standard-questions"]!.config).toEqual({ questions: [{ key: "x", ask: "X done?" }] })
		expect(bySlug["default"]!.system).toBe("custom watcher prompt")
		// Untouched detectors keep their defaults.
		expect(bySlug["repeat-failure"]!.enabled).toBe(true)
	})

	it("a broken catalogue degrades to the bundled one, never to no observer", async () => {
		const warnings: string[] = []
		const defs = await loadCatalogue(
			async () => "{not json",
			(m) => warnings.push(m),
		)
		expect(defs.length).toBe(DETECTOR_MODES.length)
		expect(defs.find((d) => d.slug === "repeat-failure")!.enabled).toBe(true)
		expect(warnings.length).toBe(1)
	})

	it("invalid override fields are dropped, valid ones kept", async () => {
		const defs = await loadCatalogue(async () => JSON.stringify({ default: { confidenceFloor: 7, cadenceNth: 2 } }))
		const def = defs.find((d) => d.slug === "default")!
		expect(def.confidenceFloor).toBe(0.65) // 7 is out of range — dropped
		expect(def.cadenceNth).toBe(2)
	})

	it("override tools are filtered to the plugin's own catalog", async () => {
		const defs = await loadCatalogue(async () =>
			JSON.stringify({ default: { tools: ["read_file", "write_to_file", "execute_command"] } }),
		)
		expect(defs.find((d) => d.slug === "default")!.tools).toEqual(["read_file", "execute_command"])
	})
})

describe("pickPilot", () => {
	it("declared pilot wins when enabled", async () => {
		const defs = await loadCatalogue(missing)
		expect(pickPilot(defs)!.slug).toBe("repeat-failure")
	})

	it("falls back to the first tool-less enabled detector, then any enabled", async () => {
		const defs = await loadCatalogue(async () => JSON.stringify({ "repeat-failure": { enabled: false } }))
		const pilot = pickPilot(defs)!
		expect(pilot.slug).toBe("standard-questions")

		const onlyTools = await loadCatalogue(async () =>
			JSON.stringify({
				"repeat-failure": { enabled: false },
				"standard-questions": { enabled: false },
			}),
		)
		expect(pickPilot(onlyTools)!.slug).toBe("default")
	})
})

describe("expandModeGrant", () => {
	it("scoped read groups expand to exactly the allowed subset ∩ plugin catalog", () => {
		const mode = DETECTOR_MODES.find((m) => m.slug === "prior-art")!
		const grant = expandModeGrant(mode)
		expect(grant).toEqual(
			expect.arrayContaining([
				"read_file",
				"grep_search",
				"list_files",
				"find_files",
				"rag_search",
				"git_search",
			]),
		)
		expect(grant).not.toContain("execute_command")
		expect(grant).not.toContain("attempt_completion") // always-available leaks are filtered
	})
})
