import { useCallback, useContext } from "react"

import i18next from "@/i18n/setup"

import { PluginUiMountContext } from "@/components/plugins/PluginUiMountContext"

/** Translate a key from the calling plugin's own catalogue. */
export type PluginTranslate = (key: string, options?: Record<string, unknown>) => string

/** i18next namespace a plugin's `locales/<lang>.json` is registered under. */
export function pluginNamespace(pluginName: string): string {
	return `plugin:${pluginName}`
}

/**
 * Translations for the **calling plugin**, from the `locales/<lang>.json` files it ships.
 *
 * A plugin UI bundle cannot reach the host's catalogue — its strings are its own — but it
 * should not have to reimplement interpolation, plurals and language fallback either. The
 * host registers each plugin's locale files as an i18next namespace (`plugin:<name>`) on
 * its **own** i18next instance, so a plugin's strings follow the user's language setting
 * and get real plural rules, with English as the fallback.
 *
 * The plugin name comes from the mount, not from an argument: a component always renders
 * inside its own plugin's slot, and passing the name would be one more thing to get
 * wrong.
 *
 * ```tsx
 * const t = usePluginTranslation()
 * <span>{t("panel.filesChanged", { count: entries.length })}</span>
 * ```
 *
 * A key with no translation renders as the key itself (i18next's default), which is
 * visible in the UI rather than silently blank.
 */
export function usePluginTranslation(): PluginTranslate {
	const { pluginName } = useContext(PluginUiMountContext)

	return useCallback(
		(key: string, options?: Record<string, unknown>) => {
			if (!pluginName) return key
			return i18next.t(key, { ...options, ns: pluginNamespace(pluginName) }) as string
		},
		[pluginName],
	)
}
