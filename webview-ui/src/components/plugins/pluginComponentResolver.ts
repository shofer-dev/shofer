import type { ComponentType } from "react"

import type { PluginUIApi, PluginUiContribution } from "@shofer/types"

/**
 * Resolves a {@link PluginUiContribution}'s `componentId` to a concrete React
 * component (design §6.8, §14 Q1, Phase 4 step 4.4).
 *
 * **Loading mechanism (owner decision §14 Q1): dynamic import + restricted API, NOT
 * an iframe.** A plugin UI component is a plain React component that receives a single
 * {@link PluginUIApi} prop (scoped channel + read-only context) — nothing else, no
 * `vscode` API, no parent-DOM handle.
 *
 * Two resolution paths:
 *
 *  1. **Co-bundled / fixture registry** ({@link registerPluginComponent}) — a component
 *     compiled into the webview bundle (or a test fixture) registers itself by
 *     `componentId`. Resolved synchronously. This is what ships working this pass.
 *
 *  2. **External bundle** (`contribution.source`) — dynamic `import()` of the plugin's
 *     UI module. Under the webview CSP (`script-src 'strict-dynamic' ${cspSource}`) the
 *     `source` MUST be a local `vscode-webview://` resource (the extension serves the
 *     plugin's built module from its `localResourceRoots`); arbitrary external hosts
 *     are blocked. Serving that resource + a shared-React import boundary is the
 *     deferred CSP work (see the Phase-4 report) — the seam exists here so wiring it
 *     up later is additive.
 */
export type PluginUIComponent = ComponentType<{ api: PluginUIApi }>

/** Co-bundled/fixture components keyed by their namespaced `componentId`. */
const registry = new Map<string, PluginUIComponent>()

/** Register a co-bundled/fixture plugin UI component under its `componentId`. */
export function registerPluginComponent(componentId: string, component: PluginUIComponent): void {
	registry.set(componentId, component)
}

/** Remove a registered component (used by tests for isolation). */
export function unregisterPluginComponent(componentId: string): void {
	registry.delete(componentId)
}

/** The synchronously-known component for `componentId`, if co-bundled/registered. */
export function getRegisteredPluginComponent(componentId: string): PluginUIComponent | undefined {
	return registry.get(componentId)
}

/**
 * Resolve the component for a contribution. Prefers the co-bundled registry; falls
 * back to a dynamic `import()` of `contribution.source` (local `vscode-webview://`
 * resource only, per the CSP). Returns `undefined` when neither path yields a
 * component — the caller then renders nothing (non-breaking).
 */
export async function resolvePluginComponent(
	contribution: PluginUiContribution,
): Promise<PluginUIComponent | undefined> {
	const local = registry.get(contribution.componentId)
	if (local) return local

	if (contribution.source) {
		// Dynamic import of a local plugin UI bundle. `@vite-ignore` keeps Vite from
		// trying to statically resolve/pre-bundle this runtime URL.
		const module: unknown = await import(/* @vite-ignore */ contribution.source)
		const mod = module as { default?: PluginUIComponent; component?: PluginUIComponent }
		return mod.default ?? mod.component
	}

	return undefined
}
