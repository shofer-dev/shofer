/**
 * governance — org-controlled **suppression, activation and DELIVERY** of
 * plugins, delivered as pod ENV VARS.
 *
 * The SaaS `resource-manager` sets these on the executor / code-server pod (the
 * same delivery channel as `SHOFER_GLOBAL_DIR`), letting an org fully define the
 * available mode set via a config bundle: naming `builtin-config` in
 * `SHOFER_DISABLED_PLUGINS` removes the built-in modes so that ONLY
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

import * as path from "path"

/**
 * Plugin names the deployment has suppressed (`SHOFER_DISABLED_PLUGINS`,
 * comma-separated) — enforced by `PluginManager` (`forceDisabledPlugins`), which
 * ignores the user's enable state for them. "Remove the built-in modes" is
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

/**
 * Directories the deployment PROVISIONED plugin code into (`SHOFER_PLUGIN_DIRS`,
 * `path.delimiter`-separated absolute paths) — scanned in addition to the three
 * standard roots, **read-only**, and LAST, so nothing under `~/.shofer/plugins`
 * or a project's `.shofer/plugins` can shadow a name the host provisioned.
 *
 * This is the delivery half of the same story {@link governanceEnabledPlugins}
 * tells about activation, and it exists because the standard roots are all
 * *writable by the person the plugin may be constraining*. `~/.shofer/plugins`
 * lives in the user's home directory: whoever holds a shell there can edit an
 * org-mandated plugin's code, replace it with their own, or move the whole
 * `.shofer` directory aside — and a plugin the subject can rewrite enforces
 * nothing. A host that mounts its plugins somewhere the user cannot write, and
 * names that path here, closes all three.
 *
 * Relative entries are DROPPED rather than resolved against the process cwd: a
 * governance path resolved against whatever directory the host happened to
 * start in is a silently different directory, and silently discovering nothing
 * is precisely the failure this variable exists to prevent. Order is preserved
 * (later wins on a name collision) and duplicates collapse.
 */
export function governancePluginDirs(): string[] {
	const dirs: string[] = []
	const seen = new Set<string>()
	for (const entry of (process.env.SHOFER_PLUGIN_DIRS ?? "").split(path.delimiter)) {
		const trimmed = entry.trim()
		if (!trimmed || !path.isAbsolute(trimmed) || seen.has(trimmed)) continue
		seen.add(trimmed)
		dirs.push(trimmed)
	}
	return dirs
}
