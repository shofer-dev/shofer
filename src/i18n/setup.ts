import i18next from "i18next"

import { i18nLog } from "../utils/logging/subsystems"

// Build translations object
const translations: Record<string, Record<string, any>> = {}

// Determine if running in test environment
const isTestEnv = process.env.NODE_ENV === "test"

// Load translations based on environment
if (!isTestEnv) {
	try {
		// Dynamic imports to avoid browser compatibility issues
		const fs = require("fs")
		const path = require("path")

		const localesDir = path.join(__dirname, "i18n", "locales")

		try {
			// Find all language directories
			const languageDirs = fs.readdirSync(localesDir, { withFileTypes: true })

			const languages = languageDirs
				.filter(
					(dirent: { isDirectory: () => boolean; name: string }) =>
						dirent.isDirectory() && !dirent.name.startsWith("."),
				)
				.map((dirent: { name: string }) => dirent.name)

			// Process each language
			languages.forEach((language: string) => {
				const langPath = path.join(localesDir, language)

				// Find all JSON files in the language directory
				const files = fs
					.readdirSync(langPath, { withFileTypes: true })
					.filter(
						(dirent: { isFile: () => boolean; name: string }) =>
							dirent.isFile() && dirent.name.endsWith(".json") && !dirent.name.startsWith("."),
					)
					.map((dirent: { name: string }) => dirent.name)

				// Initialize language in translations object
				if (!translations[language]) {
					translations[language] = {}
				}

				// Process each namespace file
				files.forEach((file: string) => {
					const namespace = path.basename(file, ".json")
					const filePath = path.join(langPath, file)

					try {
						// Read and parse the JSON file
						const content = fs.readFileSync(filePath, "utf8")
						translations[language][namespace] = JSON.parse(content)
					} catch (error) {
						i18nLog.error(`Error loading translation file ${filePath}:`, { error: String(error) })
					}
				})
			})

			i18nLog.info(`Loaded translations for languages: ${Object.keys(translations).join(", ")}`)
		} catch (dirError) {
			i18nLog.error(`Error processing directory ${localesDir}:`, { error: String(dirError) })
		}
	} catch (error) {
		i18nLog.error("Error loading translations:", { error: String(error) })
	}
}

// Initialize i18next with configuration
i18next.init({
	lng: "en",
	fallbackLng: "en",
	debug: false,
	resources: translations,
	interpolation: {
		escapeValue: false,
	},
})

export default i18next
