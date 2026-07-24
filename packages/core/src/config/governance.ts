/**
 * governance — org-controlled suppression of Shofer's built-in modes and
 * workflows, delivered as pod ENV VARS.
 *
 * The SaaS `resource-manager` sets these on the executor / code-server pod (the
 * same delivery channel as `SHOFER_GLOBAL_DIR`), letting an org fully define the
 * available mode / workflow set via a config bundle: when a flag is truthy the
 * corresponding built-ins are removed from every enumeration point so that ONLY
 * user/project/bundle-provided modes/workflows remain.
 *
 * These are read-only env flags, deliberately NOT persisted user settings: they
 * never appear in `globalSettingsSchema` or the Settings UI and cannot be
 * toggled from the webview. The webview learns their effect from the host, which
 * forwards the computed booleans on `ExtensionState`
 * (`disableBuiltInModes` / `disableBuiltInWorkflows`).
 *
 * `getAllModes()` (in `@shofer/types`) and the workflow discovery point stay
 * pure — they take the flag as an argument; this module is the single place the
 * env var is read and normalized so every host-side caller agrees on truthiness.
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
export function builtInModesDisabled(): boolean {
	return envFlagEnabled("SHOFER_DISABLE_BUILTIN_MODES")
}

/**
 * True when `SHOFER_DISABLE_BUILTIN_WORKFLOWS` is set truthy — the built-in
 * `.slang` workflows are suppressed and only bundle/user/project workflows
 * remain.
 */
export function builtInWorkflowsDisabled(): boolean {
	return envFlagEnabled("SHOFER_DISABLE_BUILTIN_WORKFLOWS")
}
