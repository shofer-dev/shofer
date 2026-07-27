/**
 * governance — org-controlled **suppression and activation** of plugins,
 * delivered as pod ENV VARS.
 *
 * The SaaS `resource-manager` sets these on the executor / code-server pod (the
 * same delivery channel as `SHOFER_GLOBAL_DIR`), letting an org fully define the
 * available mode / workflow set via a config bundle: when a flag is truthy the
 * corresponding built-ins are removed so that ONLY user/project/bundle-provided
 * modes/workflows remain.
 *
 * The built-ins ship as **bundled plugins** (`builtin-modes`, `builtin-workflows`),
 * so suppression has exactly one expression — {@link governanceDisabledPlugins},
 * consumed by `PluginManager`'s `forceDisabledPlugins`. There is no second
 * enumeration point to keep in sync, and nothing for the webview to learn: a
 * suppressed plugin simply contributes nothing, so its modes never reach any list.
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

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"])

/** Normalize an env var to a boolean: truthy for "1"/"true"/"yes"/"on" (case-insensitive). */
function envFlagEnabled(name: string): boolean {
	const raw = process.env[name]
	return raw !== undefined && TRUTHY_VALUES.has(raw.trim().toLowerCase())
}

/**
 * True when `SHOFER_DISABLE_BUILTIN_MODES` is set truthy — the six built-in
 * modes are suppressed and only bundle/user/project modes remain.
 */
function builtInModesDisabled(): boolean {
	return envFlagEnabled("SHOFER_DISABLE_BUILTIN_MODES")
}

/**
 * True when `SHOFER_DISABLE_BUILTIN_WORKFLOWS` is set truthy — the built-in
 * `.slang` workflows are suppressed and only bundle/user/project workflows
 * remain.
 */
function builtInWorkflowsDisabled(): boolean {
	return envFlagEnabled("SHOFER_DISABLE_BUILTIN_WORKFLOWS")
}

/**
 * Bundled plugin names the org env flags suppress. The built-ins ship as plugins now,
 * so "remove the built-ins" is "do not load these plugins" — enforced by
 * `PluginManager` (`forceDisabledPlugins`), which ignores the user's enable state for
 * them, exactly as the flags did when the built-ins lived in core.
 *
 * `SHOFER_DISABLED_PLUGINS` (comma-separated) is the general form: an org can suppress
 * any bundled plugin, not just the two the original flags knew about.
 */
export function governanceDisabledPlugins(): string[] {
	const disabled = new Set<string>()
	if (builtInWorkflowsDisabled()) disabled.add("builtin-workflows")
	if (builtInModesDisabled()) disabled.add("builtin-modes")
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
