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
 * i18n keys for category labels.
 * The UI attempts to render `settings:logging.categories.<lowercase(ctx)>`.
 * If a ctx string doesn't have a matching key, the raw ctx value is
 * displayed directly (no translation layer needed for new categories).
 */
function categoryLabelKey(ctx: string): string {
	// Map known ctx values to their i18n keys
	const known = new Map<string, string>([
		["Task", "task"],
		["Webview", "webview"],
		["Git", "git"],
		["CodeIndex", "codeIndex"],
		["AssistantAgent", "assistantAgent"],
		["MCP", "mcp"],
		["Checkpoints", "checkpoints"],
		["API", "api"],
		["FS", "fs"],
		["Config", "config"],
		["Skills", "skills"],
		["Marketplace", "marketplace"],
		["Metrics", "metrics"],
		["Workflow", "workflow"],
		["I18n", "i18n"],
		["Utils", "utils"],
	])
	return known.get(ctx) ?? ctx // fallback to raw value for new/unknown categories
}

type LoggingSettingsProps = HTMLAttributes<HTMLDivElement> & {
	logLevel?: LogLevel
	logCategories?: string[]
	logCategoriesKnown?: string[]
	setCachedStateField: SetCachedStateField<"logLevel" | "logCategories">
}

export const LoggingSettings = ({
	logLevel,
	logCategories,
	logCategoriesKnown,
	setCachedStateField,
	...props
}: LoggingSettingsProps) => {
	const { t } = useAppTranslation()

	const currentLevel: LogLevel = logLevel ?? "info"

	// Dynamically known categories — auto-populated from the live transport.
	// Falls back to a hardcoded set before any log lines have been emitted.
	const categories =
		logCategoriesKnown && logCategoriesKnown.length > 0
			? logCategoriesKnown
			: [
					"Task",
					"Webview",
					"Git",
					"CodeIndex",
					"AssistantAgent",
					"MCP",
					"Checkpoints",
					"API",
					"FS",
					"Config",
					"Skills",
					"Marketplace",
					"Metrics",
					"Workflow",
					"I18n",
					"Utils",
				]

	// undefined → show all; empty array → show none; non-empty → whitelist
	const selectedCategories: Set<string> = new Set(logCategories)

	const toggleCategory = (category: string) => {
		const next = new Set(selectedCategories)

		if (next.has(category)) {
			next.delete(category)
		} else {
			if (next.size === 0 && logCategories === undefined) {
				categories.forEach((c) => next.add(c))
				next.delete(category)
			} else {
				next.add(category)
			}
		}

		if (next.size === 0 || next.size === categories.length) {
			setCachedStateField("logCategories", undefined)
		} else {
			setCachedStateField("logCategories", [...next])
		}
	}

	const isCategoryEnabled = (category: string): boolean => {
		if (logCategories === undefined) return true
		return logCategories.includes(category)
	}

	const categoryCount = logCategories?.length ?? categories.length

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
						{t("settings:logging.categoriesLabel")} ({categoryCount}/{categories.length})
					</label>
					<div className="text-vscode-descriptionForeground text-xs mb-3">
						{t("settings:logging.categoriesDescription")}
					</div>
					<div className="grid grid-cols-2 gap-1">
						{categories.map((ctx) => {
							// Try i18n key first, fall back to raw ctx if key is missing
							const labelKey = categoryLabelKey(ctx)
							const key = `settings:logging.categories.${labelKey}`
							const translated = t(key)
							const label = translated !== key ? translated : ctx
							return (
								<VSCodeCheckbox
									key={ctx}
									checked={isCategoryEnabled(ctx)}
									onChange={() => toggleCategory(ctx)}
									data-testid={`log-category-${ctx}`}>
									{label}
								</VSCodeCheckbox>
							)
						})}
					</div>
				</SearchableSetting>
			</Section>
		</div>
	)
}
