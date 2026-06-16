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
					"LiveMemory",
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
					"Scroll",
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

	// Count only displayed categories that are enabled so the label can never
	// read e.g. "16/6" when a stale whitelist references categories that are no
	// longer in the known set.
	const categoryCount = categories.filter((c) => isCategoryEnabled(c)).length

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
							// The checkbox label is the raw `ctx` tag so it matches
							// exactly what appears in the Output Channel (e.g.
							// `[CodeIndex]`). `ctx` is the single source of truth —
							// no separate translated label layer that could drift.
							return (
								<VSCodeCheckbox
									key={ctx}
									checked={isCategoryEnabled(ctx)}
									onChange={() => toggleCategory(ctx)}
									data-testid={`log-category-${ctx}`}>
									{ctx}
								</VSCodeCheckbox>
							)
						})}
					</div>
				</SearchableSetting>
			</Section>
		</div>
	)
}
