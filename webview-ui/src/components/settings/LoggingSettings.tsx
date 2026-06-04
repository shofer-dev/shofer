import { HTMLAttributes } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"

type LogLevel = "debug" | "info" | "warn" | "error" | "fatal"

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error", "fatal"]

const LOG_LEVEL_DESCRIPTIONS: Record<LogLevel, string> = {
	debug: "All messages including detailed diagnostic information. Very verbose.",
	info: "Standard operational messages. Default for production.",
	warn: "Warnings and above — things that may need attention.",
	error: "Errors only — failures that affect functionality.",
	fatal: "Fatal errors only — the most severe failures.",
}

/**
 * All known subsystem categories.
 * Must match the `ctx` values in `src/utils/logging/subsystems.ts` and
 * the `ALL_CATEGORIES` const in `CompactTransport.ts`.
 */
const CATEGORIES = [
	{ id: "Task", labelKey: "task" },
	{ id: "Webview", labelKey: "webview" },
	{ id: "Git", labelKey: "git" },
	{ id: "CodeIndex", labelKey: "codeIndex" },
	{ id: "AssistantAgent", labelKey: "assistantAgent" },
	{ id: "MCP", labelKey: "mcp" },
	{ id: "Checkpoints", labelKey: "checkpoints" },
	{ id: "API", labelKey: "api" },
	{ id: "FS", labelKey: "fs" },
	{ id: "Config", labelKey: "config" },
	{ id: "Skills", labelKey: "skills" },
	{ id: "Marketplace", labelKey: "marketplace" },
	{ id: "Metrics", labelKey: "metrics" },
	{ id: "Workflow", labelKey: "workflow" },
	{ id: "I18n", labelKey: "i18n" },
	{ id: "Utils", labelKey: "utils" },
] as const

type LoggingSettingsProps = HTMLAttributes<HTMLDivElement> & {
	logLevel?: LogLevel
	logCategories?: string[]
	setCachedStateField: SetCachedStateField<"logLevel" | "logCategories">
}

export const LoggingSettings = ({ logLevel, logCategories, setCachedStateField, ...props }: LoggingSettingsProps) => {
	const { t } = useAppTranslation()

	const currentLevel: LogLevel = logLevel ?? "info"
	// undefined → show all; empty array → show none; non-empty → whitelist
	const selectedCategories: Set<string> = new Set(logCategories)

	const toggleCategory = (category: string) => {
		const next = new Set(selectedCategories)

		if (next.has(category)) {
			next.delete(category)
		} else {
			// When first category is added, start from the full set so the
			// user doesn't have to tick every single one.
			if (next.size === 0 && logCategories === undefined) {
				// User is moving from "all" to a whitelist — pre-fill all,
				// then remove this one so they deselect by unchecking.
				CATEGORIES.forEach((c) => next.add(c.id))
				next.delete(category)
			} else {
				next.add(category)
			}
		}

		// If the user selected all categories, or none, set undefined (show all)
		if (next.size === 0 || next.size === CATEGORIES.length) {
			setCachedStateField("logCategories", undefined)
		} else {
			setCachedStateField("logCategories", [...next])
		}
	}

	const isCategoryEnabled = (category: string): boolean => {
		if (logCategories === undefined) return true
		return logCategories.includes(category)
	}

	const categoryCount = logCategories?.length ?? CATEGORIES.length

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.logging")}</SectionHeader>

			<Section>
				<div className="text-vscode-descriptionForeground text-sm mb-4">
					{t("settings:logging.description")}
				</div>

				<SearchableSetting settingId="logging-level" section="logging" label={t("settings:logging.levelLabel")}>
					<label className="block font-medium mb-2">{t("settings:logging.levelLabel")}</label>
					<div className="flex flex-wrap gap-2">
						{LOG_LEVELS.map((level) => (
							<button
								key={level}
								type="button"
								onClick={() => setCachedStateField("logLevel", level)}
								className={`px-3 py-2 rounded text-sm font-medium border transition-colors ${
									currentLevel === level
										? "bg-vscode-button-background text-vscode-button-foreground border-vscode-button-background"
										: "bg-vscode-input-background text-vscode-foreground border-vscode-input-border hover:bg-vscode-list-hoverBackground"
								}`}
								data-testid={`log-level-${level}`}>
								{t(`settings:logging.levels.${level}`)}
							</button>
						))}
					</div>
					<div className="text-vscode-descriptionForeground text-xs mt-2">
						{LOG_LEVEL_DESCRIPTIONS[currentLevel]}
					</div>
				</SearchableSetting>

				<SearchableSetting
					settingId="logging-categories"
					section="logging"
					label={t("settings:logging.categoriesLabel")}>
					<label className="block font-medium mb-2">
						{t("settings:logging.categoriesLabel")} ({categoryCount}/{CATEGORIES.length})
					</label>
					<div className="text-vscode-descriptionForeground text-xs mb-3">
						{t("settings:logging.categoriesDescription")}
					</div>
					<div className="grid grid-cols-2 gap-1">
						{CATEGORIES.map(({ id, labelKey }) => (
							<VSCodeCheckbox
								key={id}
								checked={isCategoryEnabled(id)}
								onChange={() => toggleCategory(id)}
								data-testid={`log-category-${id}`}>
								{t(`settings:logging.categories.${labelKey}`)}
							</VSCodeCheckbox>
						))}
					</div>
				</SearchableSetting>
			</Section>
		</div>
	)
}
