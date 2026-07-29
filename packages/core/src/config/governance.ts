/**
 * governance — org-controlled **suppression and activation** of plugins,
 * delivered as pod ENV VARS.
 *
 * The SaaS `resource-manager` sets these on the executor / code-server pod (the
 * same delivery channel as `SHOFER_GLOBAL_DIR`), letting an org fully define the
 * available mode / workflow set via a config bundle: naming `builtin-config` in
 * `SHOFER_DISABLED_PLUGINS` removes the built-in modes and workflows so that ONLY
 * user/project/bundle-provided ones remain.
 *
 * The built-ins ship as a **bundled plugin** (`builtin-config`), so suppression has
 * exactly one expression — {@link governanceDisabledPlugins}, consumed by
 * `PluginManager`'s `forceDisabledPlugins`. There is no second enumeration point to
 * keep in sync, and nothing for the webview to learn: a suppressed plugin simply
 * contributes nothing, so its modes never reach any list.
 *
 * The `basics` plugin additionally honors **feature-scoped** entries of the form
 * `basics:<feature>` (e.g. `basics:worktrees`): the manager ignores them (they match
 * no plugin name) and the plugin reads the same variable to switch one feature off —
 * one variable, two granularities (see `plugins/basics/DESIGN.md`).
 *
 * The mirror of suppression is {@link governanceEnabledPlugins}: a deployment that
 * PROVISIONS a plugin — drops it into the node's global plugin dir because the pod
 * exists to run it — needs it on without a human in the Plugins panel. `defaultEnabled`
 * cannot express that (it is bundled-scope only, deliberately: a third-party plugin must
 * never enable itself), and the alternative, seeding the host's persisted enable list,
 * would put policy in per-host state where it drifts.
 *
 * These are read-only env flags, deliberately NOT persisted user settings: they
 * never appear in `globalSettingsSchema` or the Settings UI and cannot be
 * toggled from the webview.
 */

/**
 * Plugin names the deployment has suppressed (`SHOFER_DISABLED_PLUGINS`,
 * comma-separated) — enforced by `PluginManager` (`forceDisabledPlugins`), which
 * ignores the user's enable state for them. "Remove the built-in modes/workflows" is
 * `builtin-config` here; any bundled plugin can be named.
 */
export function governanceDisabledPlugins(): string[] {
	const disabled = new Set<string>()
	for (const name of (process.env.SHOFER_DISABLED_PLUGINS ?? "").split(",")) {
		const trimmed = name.trim()
		if (trimmed) disabled.add(trimmed)
	}
	return [...disabled]
}

/**
 * Plugin names the deployment has **force-enabled** (`SHOFER_ENABLED_PLUGINS`,
 * comma-separated) — enforced by `PluginManager` (`forceEnabledPlugins`), which treats
 * them as on regardless of the user's enable list, exactly as `SHOFER_DISABLED_PLUGINS`
 * treats its names as off regardless.
 *
 * Suppression still wins: a name in both lists is off. That ordering is deliberate — the
 * two flags reach a pod through the same channel, and "this plugin must not run here" is
 * the stronger claim.
 *
 * This does NOT bypass any other gate: permissions still come from the manifest, billed
 * AI still needs its separate consent, and a plugin whose dependency closure is unmet is
 * still failed closed. It answers one question only — is this plugin on.
 */
export function governanceEnabledPlugins(): string[] {
	const enabled = new Set<string>()
	for (const name of (process.env.SHOFER_ENABLED_PLUGINS ?? "").split(",")) {
		const trimmed = name.trim()
		if (trimmed) enabled.add(trimmed)
	}
	return [...enabled]
}
