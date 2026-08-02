// Catalogue: the manifest ↔ runtime sync (contributes.modes must equal DETECTOR_MODES,
// so the declarative contribution and the code cannot drift), the layering of the
// plugin's `detectors` config over the bundled defaults (the surface an admin config
// bundle writes), the fail-closed parse, and the pilot fallback chain.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { CATALOGUE_DEFAULTS, DETECTOR_MODES } from "../src/detectors.js"
import { expandModeGrant, loadCatalogue, pickPilot } from "../src/catalogue.js"

const here = dirname(fileURLToPath(import.meta.url))

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

	it("declares a `detectors` config key, so an admin bundle can reach every override", () => {
		// A bundle's config tree has a closed key set and drops unknown keys, so the
		// overrides MUST ride the plugin's own config to be admin-authorable at all.
		const manifest = JSON.parse(readFileSync(join(here, "..", "plugin.json"), "utf8")) as {
			config: { properties: Record<string, { type?: string }> }
		}
		expect(manifest.config.properties.detectors?.type).toBe("object")
	})

	it("every mode is private — a detector leaking into a picker would be a bug", () => {
		for (const mode of DETECTOR_MODES) expect(mode.private).toBe(true)
	})
})

describe("loadCatalogue", () => {
	it("no overrides ⇒ the bundled defaults, with mode grants expanded", () => {
		const defs = loadCatalogue(undefined)
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

	it("overrides shadow defaults per field, keyed by slug", () => {
		const defs = loadCatalogue({
			"static-analysis": { enabled: true, exec: ["go build ./..."], deadlineS: 60 },
			"standard-questions": { config: { questions: [{ key: "x", ask: "X done?" }] } },
			default: { system: "custom watcher prompt" },
		})
		const bySlug = Object.fromEntries(defs.map((d) => [d.slug, d]))
		expect(bySlug["static-analysis"]!.enabled).toBe(true)
		expect(bySlug["static-analysis"]!.exec).toEqual(["go build ./..."])
		expect(bySlug["static-analysis"]!.deadlineS).toBe(60)
		expect(bySlug["standard-questions"]!.config).toEqual({ questions: [{ key: "x", ask: "X done?" }] })
		expect(bySlug["default"]!.system).toBe("custom watcher prompt")
		// Untouched detectors keep their defaults.
		expect(bySlug["repeat-failure"]!.enabled).toBe(true)
	})

	it("a malformed overrides value degrades to the bundled catalogue, never to no observer", () => {
		for (const bad of ["not an object", 42, ["an", "array"]]) {
			const warnings: string[] = []
			const defs = loadCatalogue(bad, (m) => warnings.push(m))
			expect(defs.length).toBe(DETECTOR_MODES.length)
			expect(defs.find((d) => d.slug === "repeat-failure")!.enabled).toBe(true)
			expect(warnings.length).toBe(1)
		}
	})

	it("a malformed entry for ONE detector leaves the others on their defaults", () => {
		const defs = loadCatalogue({ "git-log": "nonsense", default: { enabled: false } })
		expect(defs.find((d) => d.slug === "git-log")!.enabled).toBe(false) // bundled default
		expect(defs.find((d) => d.slug === "default")!.enabled).toBe(false) // honored override
		expect(defs.find((d) => d.slug === "repeat-failure")!.enabled).toBe(true)
	})

	it("invalid override fields are dropped, valid ones kept", () => {
		const defs = loadCatalogue({ default: { confidenceFloor: 7, cadenceNth: 2 } })
		const def = defs.find((d) => d.slug === "default")!
		expect(def.confidenceFloor).toBe(0.65) // 7 is out of range — dropped
		expect(def.cadenceNth).toBe(2)
	})

	it("override tools are filtered to the plugin's own catalog", () => {
		const defs = loadCatalogue({ default: { tools: ["read_file", "write_to_file", "execute_command"] } })
		expect(defs.find((d) => d.slug === "default")!.tools).toEqual(["read_file", "execute_command"])
	})
})

describe("pickPilot", () => {
	it("declared pilot wins when enabled", () => {
		const defs = loadCatalogue(undefined)
		expect(pickPilot(defs)!.slug).toBe("repeat-failure")
	})

	it("falls back to the first tool-less enabled detector, then any enabled", () => {
		const defs = loadCatalogue({ "repeat-failure": { enabled: false } })
		const pilot = pickPilot(defs)!
		expect(pilot.slug).toBe("standard-questions")

		const onlyTools = loadCatalogue({
			"repeat-failure": { enabled: false },
			"standard-questions": { enabled: false },
		})
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
