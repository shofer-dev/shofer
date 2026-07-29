import { isNamespacedModeSlug, type ModeConfig } from "@shofer/types"

import { getSharedPluginManager } from "./plugin-manager.js"

/**
 * The **effective mode list**: what the user's and the project's own mode files define,
 * merged with what enabled plugins contribute.
 *
 * Shofer's own six modes are plugin data now (the bundled `builtin-config` plugin), so
 * this is the one place that decides what "all modes" means. Two groups of contributed
 * modes behave differently, and the ordering below is the behaviour users had when the
 * built-ins were a constant in `@shofer/types`:
 *
 * - **Platform modes** — unqualified slugs (`code`, `architect`, …) from a bundled
 *   first-party plugin. They lead the list, and a user or project mode with the same
 *   slug **replaces one in place**, so overriding `code` neither duplicates it nor
 *   moves it to the end of the mode picker.
 * - **Namespaced modes** — `<plugin>:<slug>` from every other plugin. They can never
 *   collide, so they are simply appended after the user's own.
 *
 * Returns the authored modes unchanged when no plugin manager is wired (a headless
 * host that never built one) or when every mode-contributing plugin is disabled.
 */
export function effectiveModes(modes: ModeConfig[] | undefined): ModeConfig[] {
	// Drop any previously-merged plugin modes: they are re-derived below, so a plugin
	// the user just disabled cannot survive in a persisted copy of this list.
	const authored = (modes ?? []).filter((mode) => mode.source !== "plugin")
	const contributed = getSharedPluginManager()?.getContributedModes() ?? []

	const merged = contributed.filter((mode) => !isNamespacedModeSlug(mode.slug))
	for (const mode of authored) {
		const index = merged.findIndex((m) => m.slug === mode.slug)
		if (index === -1) {
			merged.push(mode)
		} else {
			merged[index] = mode
		}
	}
	merged.push(...contributed.filter((mode) => isNamespacedModeSlug(mode.slug)))

	return merged
}
