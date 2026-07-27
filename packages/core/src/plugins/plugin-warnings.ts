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
import { getPluginLogger } from "./plugin-log.js"

/**
 * Surface a plugin warning **both** in the log and to the user. Routed through
 * `getHost().notifier` so it works in any host; the in-memory host (tests,
 * pre-front-end) records it instead of popping a dialog, keeping core
 * host-agnostic. A missing/partial host never breaks the caller — logging already
 * happened.
 *
 * When `pluginName` is given, the log line goes to that plugin's own `Plugin:<name>`
 * Log category (filterable in Settings → Logging) instead of the shared `Config` one.
 */
export function warnPlugin(message: string, pluginName?: string): void {
	;(pluginName ? getPluginLogger(pluginName) : configLog).warn(message)
	try {
		getHost().notifier.warn(message)
	} catch {
		// No host yet (or a partial one). This is not a rare edge: code plugins load
		// during activation, BEFORE the front-end adapter registers its notifier, so a
		// plugin that fails to load would otherwise vanish — the log line goes to an
		// output channel a headless node has no reader for, and the notification has
		// nowhere to go. A plugin that does not load is the whole feature missing, so
		// say it on stderr rather than let it be silent.
		console.error(message)
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
