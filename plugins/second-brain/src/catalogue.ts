/**
 * catalogue — merges the built-in detector modes with the workspace's overrides into
 * the effective detector definitions a pass runs.
 *
 * Layers, lowest first: the mode definitions + CATALOGUE_DEFAULTS (bundled) → the
 * plugin's own `detectors` config value, keyed by unqualified mode slug.
 *
 * **Why the plugin's config and not a file of our own.** Overrides must be authorable
 * by an admin as a *config bundle* (`docs/shofer_bundles.md`), and a bundle's `config`
 * tree has a CLOSED key set — `settings`, `modes`, `mcp`, `commands`, `rules`,
 * `skills`, `workflows`, `plugins` — materialized to fixed `.shofer/` paths, with any
 * unknown key silently dropped. A bespoke `.shofer/second-brain/catalogue.json` is
 * therefore unreachable from a bundle: an admin could author it and it would never
 * arrive. Riding the plugin's `config` instead puts the catalogue inside
 * `settings.pluginConfigs["second-brain"].detectors`, which materializes to
 * `.shofer/settings.json` and reaches the plugin through the layered overlay — so
 * every parameter is admin-controllable through the mechanism that already exists.
 *
 * Values are validated field by field and anything invalid is dropped, so a malformed
 * override degrades to the bundled catalogue rather than to no observer.
 */

import { getToolsForMode, type ModeConfig } from "@shofer/types"

import { CATALOGUE_DEFAULTS, DETECTOR_MODES } from "./detectors.js"
import { GATE_CONFIDENCE_FLOOR, type DetectorDef } from "./types.js"

/** The plugin-config key holding the per-detector overrides, keyed by mode slug. */
export const CATALOGUE_CONFIG_KEY = "detectors"

/** The tools the plugin's fork dispatcher actually implements (tool-executor.ts). */
export const PLUGIN_TOOL_CATALOG = new Set([
	"read_file",
	"grep_search",
	"list_files",
	"find_files",
	"rag_search",
	"git_search",
	"execute_command",
])

interface CatalogueOverride {
	enabled?: boolean
	cadenceNth?: number
	confidenceFloor?: number
	deadlineS?: number
	exec?: string[]
	system?: string
	tools?: string[]
	config?: Record<string, unknown>
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string")
}

/** Validate one override entry field-by-field; unknown/invalid fields are dropped. */
function parseOverride(raw: unknown): CatalogueOverride {
	if (typeof raw !== "object" || raw === null) return {}
	const o = raw as Record<string, unknown>
	const out: CatalogueOverride = {}
	if (typeof o.enabled === "boolean") out.enabled = o.enabled
	if (typeof o.cadenceNth === "number" && o.cadenceNth >= 1) out.cadenceNth = Math.floor(o.cadenceNth)
	if (typeof o.confidenceFloor === "number" && o.confidenceFloor >= 0 && o.confidenceFloor <= 1)
		out.confidenceFloor = o.confidenceFloor
	if (typeof o.deadlineS === "number" && o.deadlineS > 0) out.deadlineS = o.deadlineS
	if (isStringArray(o.exec)) out.exec = o.exec
	if (typeof o.system === "string" && o.system.trim()) out.system = o.system
	if (isStringArray(o.tools)) out.tools = o.tools
	if (typeof o.config === "object" && o.config !== null) out.config = o.config as Record<string, unknown>
	return out
}

/** Expand a mode's grant into the plugin-catalog tool names the dispatcher honors. */
export function expandModeGrant(mode: ModeConfig): string[] {
	const expanded = getToolsForMode(mode.tools, mode.tools_allowed, mode.tools_denied)
	return expanded.filter((name) => PLUGIN_TOOL_CATALOG.has(name))
}

/**
 * Load the effective detector definitions from the plugin's `detectors` config value
 * (`ctx.config.detectors`), layered over the bundled catalogue.
 */
export function loadCatalogue(raw: unknown, warn: (message: string) => void = () => {}): DetectorDef[] {
	let overrides: Record<string, CatalogueOverride> = {}
	if (raw !== undefined && raw !== null) {
		if (typeof raw === "object" && !Array.isArray(raw)) {
			for (const [slug, entry] of Object.entries(raw as Record<string, unknown>)) {
				overrides[slug] = parseOverride(entry)
			}
		} else {
			// Degrade to the bundled catalogue — never to no observer.
			warn(`second-brain: the "${CATALOGUE_CONFIG_KEY}" config must be an object — using the bundled catalogue`)
			overrides = {}
		}
	}

	return DETECTOR_MODES.map((mode) => {
		const slug = mode.slug
		const defaults = CATALOGUE_DEFAULTS[slug] ?? { enabled: false, cadenceNth: 1, confidenceFloor: 0.6 }
		const over = overrides[slug] ?? {}
		const grant = over.tools ? over.tools.filter((name) => PLUGIN_TOOL_CATALOG.has(name)) : expandModeGrant(mode)
		const def: DetectorDef = {
			slug,
			enabled: over.enabled ?? defaults.enabled,
			system: over.system ?? [mode.roleDefinition, mode.customInstructions].filter(Boolean).join("\n\n"),
			tools: grant,
			exec: over.exec ?? defaults.exec ?? [],
			cadenceNth: over.cadenceNth ?? defaults.cadenceNth,
			confidenceFloor: over.confidenceFloor ?? defaults.confidenceFloor ?? GATE_CONFIDENCE_FLOOR,
			deadlineS: over.deadlineS ?? defaults.deadlineS ?? 0,
			pilot: defaults.pilot ?? false,
			structural: defaults.structural ?? false,
			provider: mode.provider,
			config: over.config ?? defaults.config,
		}
		return def
	})
}

/** The pilot fallback chain: declared pilot → first tool-less enabled → any enabled. */
export function pickPilot(defs: DetectorDef[]): DetectorDef | undefined {
	const enabled = defs.filter((d) => d.enabled)
	return (
		enabled.find((d) => d.pilot) ?? enabled.find((d) => d.tools.length === 0 && d.exec.length === 0) ?? enabled[0]
	)
}
