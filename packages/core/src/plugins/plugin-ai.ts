/**
 * plugin-ai — the host-LLM/embeddings capability handed to a plugin via `ctx.ai`
 * (design §6.11 G1, §8; Phase 6, P6.G1).
 *
 * A plugin granted `permissions.ai` **and** the billed-calls consent (§8) gets a live
 * {@link PluginAi} that reuses the host's `buildApiHandler` seam: it can build the same
 * `ApiHandler` the main agent uses (never raw API keys) and embed text via a host
 * embedder. The *construction* is host-side (it needs the extension's
 * `ProviderSettingsManager` + embedder), so `@shofer/core` stays host-agnostic by
 * consuming a {@link PluginAiProvider} seam the extension/CLI supplies — mirroring how
 * live-memory's `LiveMemoryLlmClient` reaches `buildApiHandler`.
 *
 * Two fail-closed states (design §8):
 * - `permissions.ai` granted but **not** consented ⇒ {@link createDeniedPluginAi}: every
 *   call throws + warns (a plugin can never silently bill the user).
 * - `permissions.ai` ungranted ⇒ `ctx.ai` is absent entirely (the manager never builds
 *   an AI surface at all).
 *
 * The plugin only ever receives the opaque `ApiHandler` — the provider settings and
 * keys stay entirely on the host side of {@link PluginAiProvider}.
 */

import type { PluginAi } from "@shofer/types"

import type { ApiHandler } from "../api/api-handler-types.js"
import { warnPlugin } from "./plugin-warnings.js"

/**
 * Host seam that constructs a plugin's AI capabilities (P6.G1). Supplied by the
 * extension/CLI where the provider-settings + embedder live, so core never imports
 * `ProviderSettingsManager`. `buildHandler` resolves a provider profile (the default
 * when `profileRef` is omitted) and returns the host's `ApiHandler`; `embed` reuses a
 * host embedder. Neither ever exposes keys.
 */
export interface PluginAiProvider {
	/** Build the host `ApiHandler` for `profileRef` (name/id), or the default profile. */
	buildHandler(profileRef?: string): Promise<ApiHandler>
	/** Embed `texts` via a host embedder, one vector per input text. */
	embed(texts: string[], profileRef?: string): Promise<number[][]>
}

/**
 * The live {@link PluginAi} for a consented plugin: delegates to the host
 * {@link PluginAiProvider}. Typed as `PluginAi<ApiHandler>`, which is assignable to the
 * browser-safe `PluginAi` (`PluginAi<unknown>`) on `PluginContext.ai`. Errors from the
 * provider are surfaced to the plugin (it awaits the promise) and additionally warned so
 * a misconfigured provider is visible in the host log.
 */
export function createPluginAi(pluginName: string, provider: PluginAiProvider): PluginAi<ApiHandler> {
	return {
		async buildHandler(profileRef?: string): Promise<ApiHandler> {
			try {
				return await provider.buildHandler(profileRef)
			} catch (error) {
				warnPlugin(`[plugin:${pluginName}] ctx.ai.buildHandler failed: ${String(error)}`)
				throw error
			}
		},
		async embed(texts: string[], profileRef?: string): Promise<number[][]> {
			try {
				return await provider.embed(texts, profileRef)
			} catch (error) {
				warnPlugin(`[plugin:${pluginName}] ctx.ai.embed failed: ${String(error)}`)
				throw error
			}
		},
		// Live surface ⇒ the user consented; calls will run (design §8).
		hasConsent: () => true,
	}
}

/**
 * The **denying** {@link PluginAi} for a plugin that declared `permissions.ai` but has
 * not been AI-consented (design §8). Every call throws a descriptive error and emits a
 * shown + logged warning — the plugin fails loudly, and the user is never silently
 * billed. Distinct from an *absent* `ctx.ai` (ungranted): here the field is present so a
 * plugin author gets a clear "not consented" error rather than a missing API.
 */
export function createDeniedPluginAi(
	pluginName: string,
	warn: (message: string) => void = warnPlugin,
): PluginAi<ApiHandler> {
	const deny = (op: string): never => {
		const message =
			`[plugin:${pluginName}] ctx.ai.${op} denied — the plugin declares permissions.ai but ` +
			`the user has not consented to its billed AI calls. Consent it in the Plugins panel.`
		warn(message)
		throw new Error(message)
	}
	return {
		// `async` so `deny`'s throw surfaces as a rejected promise (matching the
		// `Promise`-returning contract), not a synchronous throw at the call site.
		async buildHandler(): Promise<ApiHandler> {
			return deny("buildHandler")
		},
		async embed(): Promise<number[][]> {
			return deny("embed")
		},
		// Denying stub ⇒ granted-but-not-consented; calls would throw (design §8). Lets a
		// plugin read the consent state without triggering the deny path.
		hasConsent: () => false,
	}
}
