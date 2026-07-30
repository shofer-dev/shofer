/**
 * catalogue — merges the built-in detector modes with the workspace's overrides into
 * the effective detector definitions a pass runs.
 *
 * Layers, lowest first: the mode definitions + CATALOGUE_DEFAULTS (bundled) →
 * `.shofer/second-brain/catalogue.json` (the workspace, keyed by unqualified mode
 * slug). The workspace file is the deliberate ONLY override surface — private modes
 * are hidden from the Modes UI — and it may also shadow a detector's `system` and
 * `tools`. A broken file degrades to the bundled catalogue, never to no observer
 * (fail-closed parse, warn once), and it is re-read at pass boundaries so edits take
 * effect without a restart.
 */

import { getToolsForMode, type ModeConfig } from "@shofer/types"
import type { PluginContext } from "@shofer/types"

import { CATALOGUE_DEFAULTS, DETECTOR_MODES } from "./detectors.js"
import { GATE_CONFIDENCE_FLOOR, type DetectorDef } from "./types.js"

/** Workspace-relative path of the override file (under `.shofer/`, like everything else). */
export const CATALOGUE_PATH = ".shofer/second-brain/catalogue.json"

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
 * Load the effective detector definitions. `readWorkspaceFile` is the seam (backed by
 * `ctx.host.fs.readFile` in production, a stub in tests); a missing file is the normal
 * case and reads as "no overrides".
 */
export async function loadCatalogue(
	readWorkspaceFile: (relPath: string) => Promise<string>,
	warn: (message: string) => void = () => {},
): Promise<DetectorDef[]> {
	let overrides: Record<string, CatalogueOverride> = {}
	try {
		const raw = await readWorkspaceFile(CATALOGUE_PATH)
		const parsed: unknown = JSON.parse(raw)
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			for (const [slug, entry] of Object.entries(parsed as Record<string, unknown>)) {
				overrides[slug] = parseOverride(entry)
			}
		} else {
			warn(`second-brain: ${CATALOGUE_PATH} is not an object — using the bundled catalogue`)
		}
	} catch (error) {
		if (error instanceof SyntaxError) {
			// A broken catalogue degrades to the bundled one, never to no observer.
			warn(`second-brain: ${CATALOGUE_PATH} is invalid JSON — using the bundled catalogue`)
			overrides = {}
		}
		// ENOENT and friends: no overrides, the normal case.
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

/** Convenience: a catalogue reader bound to the plugin context's host fs. */
export function catalogueReader(ctx: PluginContext): (relPath: string) => Promise<string> {
	return async (relPath: string) => {
		const fs = ctx.host?.fs
		if (!fs) throw new Error("host fs unavailable")
		return fs.readFile(relPath)
	}
}
