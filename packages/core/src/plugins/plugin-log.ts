/**
 * plugin-log — one scoped logger per plugin.
 *
 * Each plugin logs under its own `ctx` tag (`Plugin:<name>`), which the logging
 * transport auto-registers as a **Log category** (Settings → Logging). That lets a
 * user see and filter a single plugin's output independently of the core subsystems
 * and of other plugins. The `ctx` is the single source of truth — the category name
 * shown in the UI is exactly this tag.
 */

import type { ILogger } from "../logging/types.js"
import { getLogger } from "../logging/index.js"

/** Prefix for a plugin's log `ctx` tag; the suffix is the plugin name. */
export const PLUGIN_LOG_CTX_PREFIX = "Plugin:"

/** The `ctx` tag (== Settings → Logging category) a plugin's logs are emitted under. */
export function pluginLogCtx(pluginName: string): string {
	return `${PLUGIN_LOG_CTX_PREFIX}${pluginName}`
}

/** A logger scoped to one plugin — a child of the root logger tagged `Plugin:<name>`. */
export function getPluginLogger(pluginName: string): ILogger {
	return getLogger().child({ ctx: pluginLogCtx(pluginName) })
}
