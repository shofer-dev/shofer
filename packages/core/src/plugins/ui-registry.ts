import type { PluginUiContribution, PluginUiRegion } from "@shofer/types"

import { warnPlugin } from "./plugin-warnings.js"

/**
 * Plugin UI component registry (design §6.8, Phase 4 step 4.2).
 *
 * Maps a webview **region** ({@link PluginUiRegion}) to the enabled plugins that
 * contribute a UI component to it. It is the single **permission gate** for UI
 * contributions: a contribution is only recorded when the plugin's manifest granted
 * that region in `permissions.ui`. A plugin trying to contribute to a region it does
 * not have permission for is refused ({@link add} returns `false`) with a shown+logged
 * warning — it never reaches the webview (design §8, fail-closed).
 *
 * Host-agnostic (no `vscode`, no React): it deals only in the serializable
 * {@link PluginUiContribution} descriptor. The webview resolves each descriptor's
 * `componentId` to a concrete React component (`PluginSlot`, step 4.4). The registry
 * is rebuilt from enabled manifests during discovery/registration; the extension
 * pushes {@link all} to the webview.
 */
export class PluginUiRegistry {
	/** region → contributions, in insertion (install-rank) order. */
	private readonly byRegion = new Map<PluginUiRegion, PluginUiContribution[]>()

	/**
	 * Record a plugin's contribution to `region`, **permission-gated**. Refused
	 * (returns `false`, warns) when `region` is not in the plugin's granted
	 * `permissions.ui` list — so a plugin can only render into regions it declared.
	 * A granted region yields a namespaced `componentId` (`<pluginName>:<region>`) so
	 * ids are globally unique across plugins and regions.
	 *
	 * `source` (optional) is the plugin's UI-bundle URL for external/dynamic-import
	 * loading; omit it for co-bundled/fixture components the webview resolves locally.
	 */
	add(
		pluginName: string,
		region: PluginUiRegion,
		grantedRegions: readonly PluginUiRegion[],
		source?: string,
	): boolean {
		if (!grantedRegions.includes(region)) {
			warnPlugin(
				`[plugin:${pluginName}] refused UI contribution to region "${region}": not granted in permissions.ui.`,
			)
			return false
		}
		const contribution: PluginUiContribution = {
			pluginName,
			region,
			componentId: `${pluginName}:${region}`,
			source,
		}
		const list = this.byRegion.get(region)
		if (list) {
			list.push(contribution)
		} else {
			this.byRegion.set(region, [contribution])
		}
		return true
	}

	/** Contributions for `region`, in install-rank order (empty when none). */
	getForRegion(region: PluginUiRegion): PluginUiContribution[] {
		return [...(this.byRegion.get(region) ?? [])]
	}

	/** Every recorded contribution, across all regions. */
	all(): PluginUiContribution[] {
		const out: PluginUiContribution[] = []
		for (const list of this.byRegion.values()) out.push(...list)
		return out
	}

	/** Regions that have at least one contribution. */
	regions(): PluginUiRegion[] {
		return [...this.byRegion.keys()]
	}

	/** Drop all contributions (used when rebuilding after an enable/disable). */
	clear(): void {
		this.byRegion.clear()
	}
}

/**
 * The minimal shape {@link buildPluginUiRegistry} needs from a discovered plugin —
 * its name and the UI regions its manifest granted (`permissions.ui`). A subset of
 * `DiscoveredPlugin`, so callers can pass their own already-permission-checked list.
 */
export interface UiContributingPlugin {
	name: string
	/** Regions granted by the plugin's manifest `permissions.ui` (already the grant). */
	grantedRegions: readonly PluginUiRegion[]
	/**
	 * Per-region **resolved** UI-bundle source URI (a served `vscode-webview://`
	 * resource), for granted regions the plugin ships an external bundle for
	 * (`contributes.ui`). A granted region absent here has no external bundle and is
	 * resolved from the webview's co-bundled registry (`source` stays `undefined`).
	 */
	sources?: Partial<Record<PluginUiRegion, string>>
}

/**
 * Build a {@link PluginUiRegistry} from enabled plugins. In the manifest model
 * `permissions.ui` is both the **grant** and the **declaration** of which regions a
 * plugin renders into, so each granted region yields exactly one contribution
 * (permission-gated by {@link PluginUiRegistry.add}). Pass plugins in install-rank
 * order to make the registry's per-region order deterministic (design §14.7).
 */
export function buildPluginUiRegistry(plugins: readonly UiContributingPlugin[]): PluginUiRegistry {
	const registry = new PluginUiRegistry()
	for (const plugin of plugins) {
		for (const region of plugin.grantedRegions) {
			registry.add(plugin.name, region, plugin.grantedRegions, plugin.sources?.[region])
		}
	}
	return registry
}
