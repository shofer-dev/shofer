import i18next from "i18next"
import { initReactI18next } from "react-i18next"

import type { PluginLocaleBundle } from "@shofer/types"

// Build translations object
const translations: Record<string, Record<string, any>> = {}

// Dynamically load locale files
const localeFiles = import.meta.glob("./locales/**/*.json", { eager: true })

// Process all locale files
Object.entries(localeFiles).forEach(([path, module]) => {
	// Extract language and namespace from path
	// Example path: './locales/en/common.json' -> language: 'en', namespace: 'common'
	const match = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json/)

	if (match) {
		const [, language, namespace] = match

		// Initialize language object if it doesn't exist
		if (!translations[language]) {
			translations[language] = {}
		}

		// Add namespace resources to language
		translations[language][namespace] = (module as any).default || module
	}
})

console.log("Dynamically loaded translations:", Object.keys(translations))

// Initialize i18next for React
// This will be initialized with the VSCode language in TranslationProvider
i18next.use(initReactI18next).init({
	lng: "en", // Default language (will be overridden)
	fallbackLng: "en",
	debug: false,
	interpolation: {
		escapeValue: false, // React already escapes by default
	},
})

export function loadTranslations() {
	Object.entries(translations).forEach(([lang, namespaces]) => {
		try {
			Object.entries(namespaces).forEach(([namespace, resources]) => {
				i18next.addResourceBundle(lang, namespace, resources, true, true)
			})
		} catch (error) {
			console.warn(`Could not load ${lang} translations:`, error)
		}
	})
}

/**
 * Register a plugin's shipped translations as the i18next namespace `plugin:<name>`,
 * which is what `@shofer/plugin-ui`'s `usePluginTranslation` reads.
 *
 * A plugin's strings are its own — they are not in the host's catalogue — but a plugin
 * UI should still follow the user's language and get real interpolation and plural
 * rules, so its `locales/<lang>.json` files are folded into the same i18next instance
 * rather than into a parallel mechanism.
 */
export function loadPluginTranslations(bundles: PluginLocaleBundle[]): void {
	for (const { pluginName, resources } of bundles) {
		for (const [lang, tree] of Object.entries(resources)) {
			try {
				i18next.addResourceBundle(lang, `plugin:${pluginName}`, tree, true, true)
			} catch (error) {
				console.warn(`Could not load translations for plugin "${pluginName}" (${lang}):`, error)
			}
		}
	}
}

export default i18next
