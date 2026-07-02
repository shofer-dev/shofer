import i18next from "i18next"

import { i18nLog } from "../logging/subsystems.js"

import { translations } from "./locales.generated.js"

// Translations are statically imported (see locales.generated.ts) so they are
// bundled into @shofer/core and available independent of build-output layout or
// filesystem access. This replaces the previous fs/__dirname disk loading and
// works uniformly across the extension host, workers, and the CLI.
//
// Preserve the original behavior of skipping resource loading under test: with
// no resources, i18next `t(key)` returns the key itself, which is what the
// existing specs assert. Production/runtime loads the real translations.
const isTestEnv = process.env.NODE_ENV === "test"
const resources = isTestEnv ? {} : translations

if (!isTestEnv) {
	i18nLog.info(`Loaded translations for languages: ${Object.keys(translations).join(", ")}`)
}

// Initialize i18next with configuration
i18next.init({
	lng: "en",
	fallbackLng: "en",
	debug: false,
	resources,
	interpolation: {
		escapeValue: false,
	},
})

export default i18next
