import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

import type { ModeConfig } from "@shofer/types"

/**
 * The modes the bundled `builtin-config` plugin contributes, read from the plugin's
 * own manifest.
 *
 * Modes are no longer a constant in `@shofer/types` — they are plugin data, and the
 * host assembles the effective list at runtime. Tests that need "the modes a default
 * install has" therefore read the shipped manifest rather than a hand-copied fixture,
 * so an edit to a role definition can never leave the tests asserting a mode nobody
 * ships. Tagged exactly as `PluginManager.getContributedModes()` tags them.
 */

const PLUGIN_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../plugins/builtin-config")

const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "plugin.json"), "utf8")) as {
	contributes: { modes: ModeConfig[] }
}

export const BUILTIN_MODES: ModeConfig[] = manifest.contributes.modes.map((mode) => ({
	...mode,
	source: "plugin",
	pluginName: "builtin-config",
}))
