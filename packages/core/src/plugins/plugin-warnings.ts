/**
 * plugin-warnings — shared "shown + logged" warning helpers for the plugin system
 * (design §14.3/§14.7 — plugin warnings must be surfaced *and* logged).
 *
 * Extracted into its own module (rather than living in `plugin-manager`) so both
 * the manager *and* the registry/sandbox can use it without an import cycle
 * (`plugin-manager` imports `plugin-registry`, so the registry must not import back
 * into the manager for this).
 */

import { getHost } from "@shofer/types"

import { configLog } from "../logging/subsystems.js"

/**
 * Surface a plugin warning **both** in the log and to the user. Routed through
 * `getHost().notifier` so it works in any host; the in-memory host (tests,
 * pre-front-end) records it instead of popping a dialog, keeping core
 * host-agnostic. A missing/partial host never breaks the caller — logging already
 * happened.
 */
export function warnPlugin(message: string): void {
	configLog.warn(message)
	try {
		getHost().notifier.warn(message)
	} catch {
		// A missing/partial host must never break the caller — logging already happened.
	}
}

/**
 * Warn (shown + logged) about a slug/name conflict resolved by last-installed-wins
 * (design §14.7). `kind` is the contribution kind ("mode"/"command"/"skill"),
 * `slug` the colliding identity, and `winner`/`shadowed` short descriptions of the
 * winning and shadowed contributors (e.g. `plugin "b"`, `project mode`, `built-in`).
 * The winner is the *last-installed* contributor per the persisted install order.
 */
export function warnPluginConflict(kind: string, slug: string, winner: string, shadowed: string): void {
	warnPlugin(
		`[plugins] ${kind} "${slug}" from ${winner} shadows the one from ${shadowed} ` + `(last-installed wins).`,
	)
}
