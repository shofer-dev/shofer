/**
 * The feature contract inside the Basics plugin.
 *
 * Basics bundles three per-task workspace features — checkpoints, file-changes and
 * worktrees — behind ONE plugin registration. Each feature is written as a
 * {@link BasicsFeature}: the same shape as a `ShoferPlugin` minus the identity fields,
 * plus the two things composition needs — a stable {@link FeatureId} and the list of
 * core broadcast questions it answers. `src/main.ts` folds the features into the single
 * plugin the host sees, and this module owns the one policy question that creates:
 * **which features are on**.
 *
 * A feature is off when either
 *  - its boolean in the plugin config (`ctx.config[featureId]`) is `false`, or
 *  - `SHOFER_DISABLED_PLUGINS` names it as `basics:<featureId>`.
 *
 * The env form exists for deployments: the governance env vars are how a pod is told
 * what to run (see core's `governance.ts`), and a deployment that replaces one feature
 * with its own implementation (e.g. arkware's worktreed-backed worktrees/checkpoints)
 * must be able to suppress exactly that feature while keeping the rest. Core's
 * `PluginManager` ignores `basics:<feature>` entries (they match no plugin name); this
 * plugin reads the same variable and applies them at feature granularity.
 */

import type { CustomToolDefinition, LifecycleHooks, PluginContext } from "@shofer/types"

/** The three feature ids — config keys, request-method prefixes and env suffixes alike. */
export const FEATURE_IDS = ["checkpoints", "file-changes", "worktrees"] as const

export type FeatureId = (typeof FEATURE_IDS)[number]

/** One of the plugin's features, composed into the single `ShoferPlugin` by `main.ts`. */
export interface BasicsFeature {
	readonly id: FeatureId

	/** Reset process-lived state; runs on (re-)initialize regardless of enablement. */
	initialize?(context: PluginContext): void

	/** Lifecycle hooks; only invoked while the feature is enabled. */
	lifecycle?: LifecycleHooks

	/** Agent tools; only contributed while the feature is enabled. */
	registerTools?(context: PluginContext): CustomToolDefinition[]

	/**
	 * Answer a request. `method` arrives BARE — `main.ts` has already stripped the
	 * routing `local:` prefix and this feature's `<id>:` namespace, so `basics:diff`
	 * collisions between features cannot exist by construction. Unknown methods throw.
	 */
	handleRequest?(method: string, params: unknown, context: PluginContext): Promise<unknown>

	/**
	 * Core broadcast questions (`pluginRegistry.requestAll`) this feature answers.
	 * Broadcast methods are core-defined names and arrive un-namespaced; `main.ts`
	 * routes each listed name to this feature's {@link handleRequest} verbatim.
	 */
	readonly broadcasts?: readonly string[]
}

/** Env entries of this form suppress one feature: `basics:<featureId>`. */
const ENV_FEATURE_PREFIX = "basics:"

/** Feature names suppressed via `SHOFER_DISABLED_PLUGINS` (`basics:<featureId>` entries). */
function envDisabledFeatures(): Set<string> {
	const disabled = new Set<string>()
	for (const name of (process.env.SHOFER_DISABLED_PLUGINS ?? "").split(",")) {
		const trimmed = name.trim()
		if (trimmed.startsWith(ENV_FEATURE_PREFIX)) disabled.add(trimmed.slice(ENV_FEATURE_PREFIX.length))
	}
	return disabled
}

/**
 * The effective on/off map — config defaults on, a `false` config value or a
 * `basics:<featureId>` governance entry turns a feature off.
 */
export function effectiveFeatures(config: Record<string, unknown> | undefined): Record<FeatureId, boolean> {
	const suppressed = envDisabledFeatures()
	const result = {} as Record<FeatureId, boolean>
	for (const id of FEATURE_IDS) {
		result[id] = config?.[id] !== false && !suppressed.has(id)
	}
	return result
}
