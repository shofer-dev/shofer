/**
 * plugin-config-secrets — splitting a plugin's config into the half that is a
 * preference and the half that is a credential.
 *
 * A plugin declares a config property `secret: true` and the host stores its value in
 * the secret store (the OS keychain) rather than in `globalState` alongside the rest.
 * Three code paths have to agree on that boundary — the write path (what to persist
 * where), the read path (what the Plugins panel may see), and the manager (what to merge
 * into `ctx.config`) — so the rules live here rather than being re-derived at each.
 *
 * Pure functions over plain objects: no host, no storage, no `vscode`. The host supplies
 * the storage; this decides what belongs in it.
 */

/** A plugin's incoming config, separated by whether each property is a credential. */
export interface SplitPluginConfig {
	/** Ordinary properties — persisted in `pluginConfigs` (plain state). */
	plain: Record<string, unknown>
	/**
	 * Credential properties, as strings.
	 *
	 * An **empty string** is meaningful: it is how a UI says "forget this key". An
	 * absent property is the opposite — leave whatever is stored alone — which is what
	 * lets a panel that is never shown a secret's value still save the rest of the form.
	 */
	secrets: Record<string, string>
}

/** Split an incoming config object by the schema's `secret: true` property names. */
export function splitPluginConfigBySecrets(
	config: Record<string, unknown>,
	secretKeys: readonly string[],
): SplitPluginConfig {
	const plain: Record<string, unknown> = {}
	const secrets: Record<string, string> = {}
	for (const [key, value] of Object.entries(config)) {
		if (secretKeys.includes(key)) {
			// A non-string for a secret property is a caller bug, not a credential; drop it
			// rather than writing an object into the keychain.
			if (typeof value === "string") secrets[key] = value
		} else {
			plain[key] = value
		}
	}
	return { plain, secrets }
}

/**
 * Apply a split's secret half to a plugin's stored secrets: empty string deletes,
 * anything else replaces, and an absent key is left untouched.
 */
export function applyPluginSecretEdits(
	stored: Record<string, string> | undefined,
	edits: Record<string, string>,
): Record<string, string> {
	const next = { ...(stored ?? {}) }
	for (const [key, value] of Object.entries(edits)) {
		if (value === "") delete next[key]
		else next[key] = value
	}
	return next
}

/**
 * Drop any credential property from a config object on its way OUT of the host.
 *
 * The write path already routes secrets to the secret store, so this only matters for a
 * value written before its property was declared secret — but a settings panel is
 * exactly where such a leak would surface, so it is filtered rather than trusted.
 */
export function redactPluginSecretConfig(
	config: Record<string, unknown>,
	secretKeys: readonly string[],
): Record<string, unknown> {
	if (secretKeys.length === 0) return config
	return Object.fromEntries(Object.entries(config).filter(([key]) => !secretKeys.includes(key)))
}
