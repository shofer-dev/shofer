import fs from "fs/promises"
import * as path from "path"

import { getHost, globalSettingsSchema } from "@shofer/types"

import {
	mergeLayeredConfig,
	type LayeredConfigInput,
	type LayeredSettings,
	type LockedManifest,
} from "./layered-config.js"
import { loadLockedManifestFromDisk, type ScopeRoots } from "./scope-roots.js"

/**
 * layered-settings-file — the disk half of the three-scope `.shofer/settings.json`
 * overlay: read each scope's file, parse it fail-closed **per key**, and hand the
 * parsed layers to the pure merge engine ({@link mergeLayeredConfig}).
 *
 * This lives in `@shofer/core` rather than in the VS Code host because **two hosts
 * need the same answer**: the extension host (`ContextProxy`, which serves the
 * overlay to every `getValue`) and the CLI host (`shofer serve`, which must know
 * which settings its node's own configuration already decides before it seeds any
 * default of its own). A second copy would drift on the one thing that must never
 * drift — what a scope file says. No `vscode` import; pure fs + path + zod.
 *
 * The read path is deliberately **additive**: a scope with no `settings.json`
 * contributes an empty layer, so when no files exist anywhere the merged overlay is
 * `{}` and every consumer falls back to whatever it did before the overlay existed.
 *
 * ## Why one bad key does not void the file
 *
 * This reader used to `safeParse` the whole document and return `{}` on any
 * failure. That reading of the Schema-First Persistence Rule is wrong here, for
 * two reasons that are specific to a layered OVERLAY rather than to a snapshot:
 *
 * 1. **Voiding the layer does not produce a safe state, it produces a different
 *    unrequested one.** A scope file is not an atomic policy document whose keys
 *    only make sense together; it is a set of independent overrides. Discarding
 *    all of them because one is out of range does not fall back to "nothing" — it
 *    falls back to Shofer's built-in defaults, which are generally *less*
 *    restrictive than what the scope wrote. For the org-global scope, whose whole
 *    purpose is to constrain a node, "fail closed" therefore failed OPEN: one
 *    mistyped number silently dropped every restriction the org had set.
 * 2. **It was silent.** Nothing logged, nothing shown, and the file on disk still
 *    said what the operator intended, so the symptom (a setting that has no
 *    effect) pointed nowhere near the cause (a different key entirely).
 *
 * So a key whose value the schema rejects is DROPPED — that key alone — and every
 * other key in the file is honoured. No invalid value ever reaches a consumer, so
 * the Schema-First guarantee still holds; what changed is its granularity, from
 * the document to the key.
 *
 * ## Partial application is only acceptable because it is LOUD
 *
 * Keeping part of a document nobody wrote in full has its own hazard: an operator
 * can believe a setting is in force when it was thrown away. That is answered by
 * making the rejection impossible to miss rather than by discarding more — every
 * drop is reported through the host notifier (an error toast in VS Code, a
 * recorded message on a headless host) naming the file and the keys, so the
 * failure surfaces where a human is, not only in a log nobody opens.
 *
 * Two cases still void the whole layer, because no per-key salvage exists: the
 * file is not valid JSON, or its top level is not an object. Those are reported
 * the same way.
 */

/** The per-scope settings filename inside a `.shofer/` scope root. */
export const SCOPE_SETTINGS_FILE = "settings.json"

/** A key a scope file carried and the reader refused, with the schema's reason. */
export interface RejectedSetting {
	key: string
	reason: string
}

/** The outcome of parsing one scope's `settings.json` text. */
export interface ParsedScopeSettings {
	/** The keys that parsed cleanly. */
	settings: LayeredSettings
	/** Keys present in the file that the schema rejected, and why. */
	rejected: RejectedSetting[]
	/**
	 * Set when the whole document had to be discarded (not JSON, not an object,
	 * or a failure that could not be attributed to any single key) — the reason,
	 * for reporting.
	 */
	voidedReason?: string
}

/**
 * The number of drop-and-reparse passes {@link parseScopeSettings} will make.
 * Each pass removes at least one key, so the key count bounds it; this is a
 * belt-and-braces stop in case a future schema reports an issue whose path names
 * a key that removing does not fix.
 */
const MAX_REJECTION_PASSES = 256

/**
 * Parse one scope's `settings.json` TEXT, dropping only the keys the schema
 * rejects.
 *
 * Implemented as drop-and-reparse against the real schema rather than by parsing
 * each key against `globalSettingsSchema.shape[key]` separately. Both agree for a
 * flat object of independent keys, which is what `globalSettingsSchema` is today —
 * but only this form stays correct if the schema ever grows an object-level
 * `.refine`: a cross-key rule reports an issue with an EMPTY path, which cannot be
 * attributed to one key, and the loop then voids the layer (and says so) instead
 * of quietly ignoring a constraint it could not localise.
 *
 * Exported separately from {@link readScopeSettingsFile} so the decision is
 * testable without a filesystem.
 */
export function parseScopeSettings(text: string): ParsedScopeSettings {
	let doc: unknown
	try {
		doc = JSON.parse(text)
	} catch {
		return { settings: {}, rejected: [], voidedReason: "the file is not valid JSON" }
	}

	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
		return { settings: {}, rejected: [], voidedReason: "the file's top level is not a JSON object" }
	}

	const schema = globalSettingsSchema.partial()
	const remaining: Record<string, unknown> = { ...(doc as Record<string, unknown>) }
	const rejected: RejectedSetting[] = []

	for (let pass = 0; pass < MAX_REJECTION_PASSES; pass++) {
		const parsed = schema.safeParse(remaining)
		if (parsed.success) {
			return { settings: parsed.data as LayeredSettings, rejected }
		}

		// Attribute each issue to the top-level key it lives under. A nested
		// failure (`defaultCostLimit.maxUsd`) still names its owning key first,
		// which is the granularity at which a value can be dropped.
		const offenders = new Map<string, string>()
		for (const issue of parsed.error.issues) {
			const key = issue.path[0]
			if (typeof key !== "string" || !(key in remaining)) {
				continue
			}
			const where = issue.path.length > 1 ? `${issue.path.join(".")}: ` : ""
			if (!offenders.has(key)) {
				offenders.set(key, `${where}${issue.message}`)
			}
		}

		if (offenders.size === 0) {
			// Nothing to drop — the failure is about the document as a whole
			// (today only reachable via a future object-level refinement).
			return {
				settings: {},
				rejected,
				voidedReason: parsed.error.issues.map((i) => i.message).join("; "),
			}
		}

		for (const [key, reason] of offenders) {
			delete remaining[key]
			rejected.push({ key, reason })
		}
	}

	return {
		settings: {},
		rejected,
		voidedReason: `the file still failed validation after ${MAX_REJECTION_PASSES} passes`,
	}
}

/**
 * The last problem reported per scope root, so a re-read (a file watcher firing,
 * `ContextProxy` refreshing, the CLI resolving its posture once per run) does not
 * re-toast the same rejection. A root whose file becomes clean is forgotten, so a
 * problem that reappears is reported again.
 */
const reportedScopeProblems = new Map<string, string>()

/** Report a scope file's rejected keys through the host notifier, once. */
function reportScopeSettingsProblem(root: string, parsed: ParsedScopeSettings): void {
	const signature = [parsed.voidedReason ?? "", ...parsed.rejected.map((r) => `${r.key}=${r.reason}`)].join("|")

	if (!signature) {
		reportedScopeProblems.delete(root)
		return
	}
	if (reportedScopeProblems.get(root) === signature) {
		return
	}
	reportedScopeProblems.set(root, signature)

	const file = path.join(root, SCOPE_SETTINGS_FILE)
	const message = parsed.voidedReason
		? `Shofer ignored ALL of ${file}: ${parsed.voidedReason}. No setting from this scope is in effect.`
		: `Shofer ignored ${parsed.rejected.length} invalid setting(s) in ${file} — ` +
			`${parsed.rejected.map((r) => `${r.key} (${r.reason})`).join(", ")}. ` +
			`The rest of the file is in effect; the ignored keys fall back to their defaults.`

	getHost().notifier.error(message)
}

/**
 * Read and parse one scope's `settings.json`. A missing or unreadable file yields
 * `{}` silently — an absent scope is the normal case, not a fault. A file that
 * exists but carries invalid values yields every key that parsed, drops the ones
 * that did not, and reports the drops through the host notifier.
 *
 * Unknown/extra keys are stripped by the partial schema rather than aborting the
 * scope, and are NOT reported: a key from a newer Shofer than this one is not an
 * operator error.
 */
export async function readScopeSettingsFile(root: string | undefined): Promise<LayeredSettings> {
	if (!root) {
		return {}
	}

	let raw: string
	try {
		raw = await fs.readFile(path.join(root, SCOPE_SETTINGS_FILE), "utf8")
	} catch {
		reportedScopeProblems.delete(root)
		return {}
	}

	const parsed = parseScopeSettings(raw)
	reportScopeSettingsProblem(root, parsed)
	return parsed.settings
}

/**
 * Read the three scopes' `settings.json` files (plus the global scope's
 * `locked.json`) and return them **unmerged**.
 *
 * Callers that only want the effective value use {@link loadLayeredOverlay}. This
 * variant exists for callers that must distinguish *which* scope declared a key —
 * e.g. reporting the provenance of a node's approval posture — because the merged
 * result cannot answer that.
 */
export async function loadLayeredScopes(
	roots: ScopeRoots,
): Promise<{ scopes: LayeredConfigInput; manifest: LockedManifest }> {
	const [global, user, project, manifest] = await Promise.all([
		readScopeSettingsFile(roots.global),
		readScopeSettingsFile(roots.user),
		readScopeSettingsFile(roots.project),
		loadLockedManifestFromDisk(roots.global),
	])

	return { scopes: { global, user, project }, manifest }
}

/**
 * Load the merged layered overlay from disk for the given scope roots. Returns the
 * effective `.shofer/settings.json` overlay (a partial `ShoferSettings`); `{}` when
 * no scope has a readable settings file.
 */
export async function loadLayeredOverlay(roots: ScopeRoots): Promise<LayeredSettings> {
	const { scopes, manifest } = await loadLayeredScopes(roots)
	return mergeLayeredConfig(scopes, manifest)
}
