/**
 * Basics — Shofer's per-task workspace basics (checkpoints, file-changes, worktrees)
 * as ONE first-party plugin.
 *
 * The three features share a deployment story (bundled, on by default, off together
 * when a host wants a bare agent) and a UX plane (the chat timeline, the chat input
 * and the panel above it), so they ship as one plugin with three feature modules:
 *
 * | Feature       | Owns                                                            |
 * | ------------- | --------------------------------------------------------------- |
 * | `checkpoints` | shadow-git undo history + the `chat-message-addon` rows          |
 * | `file-changes`| per-task edit tracking, `get_changed_files`, the `chat-footer`   |
 * | `worktrees`   | per-task git worktrees, the branch chip, Settings tab, commands  |
 *
 * This module is pure composition — every behavior lives in `src/<feature>/feature.ts`:
 *
 * - **Lifecycle hooks** fan out to each enabled feature in the fixed order below;
 *   `beforeToolCall` short-circuits on the first block and threads `modifiedArgs`.
 * - **Requests** are namespaced `<feature>:<method>` (after the optional `local:`
 *   routing prefix, which core consumes for host-vs-executor routing but delivers
 *   verbatim — it is stripped here). Namespacing is what makes the merge safe: the
 *   features' own method names collide (`list`, `diff`, `show-diff`).
 * - **Core broadcasts** (`pluginRegistry.requestAll` questions like `task-stats` and
 *   `resolve-task-cwd`) are core-defined names and arrive un-namespaced; each feature
 *   declares the ones it answers and they are routed to it verbatim.
 * - **`features`** is answered here: the effective on/off map ({@link effectiveFeatures}),
 *   which the UI bundles query (as `local:features`) to unmount a disabled feature's
 *   surface.
 *
 * A disabled feature contributes nothing: hooks are skipped, tools are not registered,
 * and its requests throw. See `src/feature.ts` for the two off-switches (plugin config
 * and the `basics:<feature>` governance entries).
 */

import {
	PLUGIN_LOCAL_REQUEST_PREFIX,
	type BeforeToolCallResult,
	type CustomToolDefinition,
	type PluginContext,
	type PluginFileEdit,
	type PluginFileEditResult,
	type ShoferPlugin,
	type TaskDeletedInfo,
	type TaskLifecycleContext,
	type TimelineRewindInfo,
	type UserMessageInfo,
} from "@shofer/types"

import { effectiveFeatures, type BasicsFeature, type FeatureId } from "./feature.js"
import { checkpointsFeature } from "./checkpoints/feature.js"
import { fileChangesFeature } from "./file-changes/feature.js"
import { worktreesFeature } from "./worktrees/feature.js"

const PLUGIN_NAME = "basics"

/**
 * Hook/registration order. Checkpoints first so its pre-mutation snapshot exists
 * before any other feature reacts to the same event.
 */
const FEATURES: readonly BasicsFeature[] = [checkpointsFeature, fileChangesFeature, worktreesFeature]

/** The plugin-level context from `initialize` — the config source for enablement. */
let pluginCtx: PluginContext | undefined

/** The features currently on, per config + governance ({@link effectiveFeatures}). */
function enabled(): Record<FeatureId, boolean> {
	return effectiveFeatures(pluginCtx?.config)
}

/** The enabled features, in hook order. */
function enabledList(): BasicsFeature[] {
	const on = enabled()
	return FEATURES.filter((feature) => on[feature.id])
}

const plugin: ShoferPlugin = {
	name: PLUGIN_NAME,

	initialize(ctx: PluginContext): void {
		pluginCtx = ctx
		// Every feature resets, enabled or not: `initialize` re-runs on a config edit,
		// and a feature just turned OFF must drop its process-lived state too.
		for (const feature of FEATURES) feature.initialize?.(ctx)
	},

	lifecycle: {
		async beforeTaskStart(ctx: TaskLifecycleContext) {
			for (const feature of enabledList()) await feature.lifecycle?.beforeTaskStart?.(ctx)
		},

		async beforeToolCall(
			toolName: string,
			args: Record<string, unknown>,
			ctx: PluginContext,
		): Promise<BeforeToolCallResult> {
			// Thread each feature's `modifiedArgs` into the next, and stop on a block —
			// the same reducer semantics core applies across plugins.
			let currentArgs = args
			for (const feature of enabledList()) {
				const hook = feature.lifecycle?.beforeToolCall
				if (!hook) continue
				const result = await hook(toolName, currentArgs, ctx)
				if (result && result.allow === false) return result
				if (result?.modifiedArgs) currentArgs = result.modifiedArgs
			}
			return currentArgs === args ? { allow: true } : { allow: true, modifiedArgs: currentArgs }
		},

		async onUserMessage(info: UserMessageInfo, ctx: PluginContext) {
			for (const feature of enabledList()) await feature.lifecycle?.onUserMessage?.(info, ctx)
		},

		async beforeFileEdit(edit: PluginFileEdit, ctx: PluginContext) {
			for (const feature of enabledList()) await feature.lifecycle?.beforeFileEdit?.(edit, ctx)
		},

		async afterFileEdit(edit: PluginFileEditResult, ctx: PluginContext) {
			for (const feature of enabledList()) await feature.lifecycle?.afterFileEdit?.(edit, ctx)
		},

		async onTimelineRewind(info: TimelineRewindInfo, ctx: PluginContext) {
			for (const feature of enabledList()) await feature.lifecycle?.onTimelineRewind?.(info, ctx)
		},

		async onTaskDeleted(info: TaskDeletedInfo, ctx: PluginContext) {
			for (const feature of enabledList()) await feature.lifecycle?.onTaskDeleted?.(info, ctx)
		},
	},

	registerTools(ctx: PluginContext): CustomToolDefinition[] {
		return enabledList().flatMap((feature) => feature.registerTools?.(ctx) ?? [])
	},

	async handleRequest(method: string, params: unknown, ctx: PluginContext): Promise<unknown> {
		// `local:` is a ROUTING prefix (answer on the UI's host, not the task's); core
		// consumes it for routing but hands the method over verbatim.
		const bare = method.startsWith(PLUGIN_LOCAL_REQUEST_PREFIX)
			? method.slice(PLUGIN_LOCAL_REQUEST_PREFIX.length)
			: method

		if (bare === "features") return enabled()

		const separator = bare.indexOf(":")
		if (separator !== -1) {
			const featureId = bare.slice(0, separator)
			const feature = FEATURES.find((f) => f.id === featureId)
			if (!feature?.handleRequest) {
				throw new Error(`${PLUGIN_NAME}: unknown request method "${method}"`)
			}
			if (!enabled()[feature.id]) {
				throw new Error(`${PLUGIN_NAME}: the "${feature.id}" feature is disabled`)
			}
			return feature.handleRequest(bare.slice(separator + 1), params, ctx)
		}

		// Un-namespaced methods are core broadcasts; a feature must have declared the
		// name. Throwing on the rest is what makes `requestAll` treat us as silent.
		const answerer = enabledList().find((feature) => feature.broadcasts?.includes(bare))
		if (answerer?.handleRequest) return answerer.handleRequest(bare, params, ctx)

		throw new Error(`${PLUGIN_NAME}: unknown request method "${method}"`)
	},
}

export default plugin
