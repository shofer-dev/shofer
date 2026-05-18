import React from "react"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { SectionHeader } from "./SectionHeader"
import { SearchableSetting } from "./SearchableSetting"
import { CodeIndexConfigForm } from "./CodeIndexConfigForm"
import {
	Slider,
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
	Button,
} from "@src/components/ui"

interface CodebaseIndexConfig {
	codebaseIndexEnabled?: boolean
	codebaseIndexGitEnabled?: boolean
	codebaseIndexGitMaxHistoryDays?: number
	codebaseIndexGitMaxCommits?: number
	codebaseIndexGitPollIntervalMinutes?: number
	codebaseIndexGitSearchMinScore?: number
	codebaseIndexGitSearchMaxResults?: number
}

interface RagIndexerSettingsProps {
	codebaseIndexConfig?: CodebaseIndexConfig | null
	setCachedStateField: (key: string, value: any) => void
}

/**
 * Settings section for RAG Indexer configuration.
 *
 * Consolidates configuration for both the code index and git history index.
 * Reads values from the {@link codebaseIndexConfig} prop (backed by cachedState
 * in SettingsView). Updates go through {@link setCachedStateField} so the parent
 * Save button batch-persists to the extension host (Settings View Pattern).
 */
export const RagIndexerSettings: React.FC<RagIndexerSettingsProps> = ({ codebaseIndexConfig, setCachedStateField }) => {
	const { t } = useAppTranslation()

	const codeEnabled = codebaseIndexConfig?.codebaseIndexEnabled ?? true
	const gitEnabled = codebaseIndexConfig?.codebaseIndexGitEnabled ?? false
	const gitMaxHistoryDays = codebaseIndexConfig?.codebaseIndexGitMaxHistoryDays ?? 365
	const gitMaxCommits = codebaseIndexConfig?.codebaseIndexGitMaxCommits ?? 10000
	const gitPollIntervalMinutes = codebaseIndexConfig?.codebaseIndexGitPollIntervalMinutes ?? 5
	const gitSearchMinScore = codebaseIndexConfig?.codebaseIndexGitSearchMinScore ?? 0.4
	const gitSearchMaxResults = codebaseIndexConfig?.codebaseIndexGitSearchMaxResults ?? 20

	/**
	 * Update a single git-index config field inside the nested codebaseIndexConfig.
	 * Constructs a new config object and writes it via setCachedStateField so that
	 * SettingsView's Save button batch-persists to the host — no direct postMessage.
	 */
	const updateGitSetting = (key: keyof CodebaseIndexConfig, value: any) => {
		const updated = { ...codebaseIndexConfig, [key]: value }
		setCachedStateField("codebaseIndexConfig", updated)
	}

	return (
		<div>
			<SectionHeader>{t("settings:sections.codebaseIndex")}</SectionHeader>

			<div className="space-y-6">
				{/* ── Code Index ── */}
				<div>
					<h3 className="text-base font-semibold mb-3">{t("settings:codeIndex.title")}</h3>

					{/* Master enable toggle. Independent of the git-history toggle below.
					    Persisted via the parent SettingsView's Save button (cachedState
					    pattern), then propagated to the host where CodeIndexManager
					    starts/stops on the next handleSettingsChange. */}
					<div className="mb-4">
						<SearchableSetting
							settingId="codebaseIndex-enabled"
							section="codebaseIndex"
							label={t("settings:codeIndex.enableLabel")}>
							<div className="flex items-center gap-2">
								<VSCodeCheckbox
									checked={codeEnabled}
									onChange={(e: any) => updateGitSetting("codebaseIndexEnabled", e.target.checked)}>
									<span className="font-medium">{t("settings:codeIndex.enableLabel")}</span>
								</VSCodeCheckbox>
							</div>
							<p className="text-xs text-vscode-descriptionForeground mt-1">
								{t("settings:codeIndex.enableDescription")}
							</p>
						</SearchableSetting>
					</div>

					<CodeIndexConfigForm />
				</div>

				{/* ── Git History Index ── */}
				<div>
					<h3 className="text-base font-semibold mb-3">{t("settings:codeIndex.gitHistoryTitle")}</h3>

					<div className="space-y-4">
						{/* Enable Toggle */}
						<SearchableSetting
							settingId="codebaseIndex-git-enabled"
							section="codebaseIndex"
							label={t("settings:codeIndex.gitEnableLabel")}>
							<VSCodeCheckbox
								checked={gitEnabled}
								onChange={(e: any) => updateGitSetting("codebaseIndexGitEnabled", e.target.checked)}>
								<span className="font-medium">{t("settings:codeIndex.gitEnableLabel")}</span>
							</VSCodeCheckbox>
						</SearchableSetting>

						{gitEnabled && (
							<>
								{/* Max History Days */}
								<SearchableSetting
									settingId="codebaseIndex-git-max-history-days"
									section="codebaseIndex"
									label={t("settings:codeIndex.gitMaxHistoryDaysLabel")}>
									<span className="block font-medium mb-1">
										{t("settings:codeIndex.gitMaxHistoryDaysLabel")}
									</span>
									<div className="flex items-center gap-2">
										<Slider
											min={1}
											max={365}
											step={1}
											value={[gitMaxHistoryDays]}
											onValueChange={([value]) =>
												updateGitSetting("codebaseIndexGitMaxHistoryDays", value)
											}
										/>
										<span className="w-12 text-center">{gitMaxHistoryDays}</span>
									</div>
								</SearchableSetting>

								{/* Max Commits */}
								<SearchableSetting
									settingId="codebaseIndex-git-max-commits"
									section="codebaseIndex"
									label={t("settings:codeIndex.gitMaxCommitsLabel")}>
									<span className="block font-medium mb-1">
										{t("settings:codeIndex.gitMaxCommitsLabel")}
									</span>
									<div className="flex items-center gap-2">
										<Slider
											min={100}
											max={10000}
											step={100}
											value={[gitMaxCommits]}
											onValueChange={([value]) =>
												updateGitSetting("codebaseIndexGitMaxCommits", value)
											}
										/>
										<span className="w-16 text-center">{gitMaxCommits.toLocaleString()}</span>
									</div>
								</SearchableSetting>

								{/* Poll Interval */}
								<SearchableSetting
									settingId="codebaseIndex-git-poll-interval"
									section="codebaseIndex"
									label={t("settings:codeIndex.gitPollIntervalLabel")}>
									<span className="block font-medium mb-1">
										{t("settings:codeIndex.gitPollIntervalLabel")}
									</span>
									<div className="flex items-center gap-2">
										<Slider
											min={1}
											max={60}
											step={1}
											value={[gitPollIntervalMinutes]}
											onValueChange={([value]) =>
												updateGitSetting("codebaseIndexGitPollIntervalMinutes", value)
											}
										/>
										<span className="w-12 text-center">{gitPollIntervalMinutes} min</span>
									</div>
								</SearchableSetting>

								{/* Search Min Score */}
								<SearchableSetting
									settingId="codebaseIndex-git-search-min-score"
									section="codebaseIndex"
									label={t("settings:codeIndex.gitSearchMinScoreLabel")}>
									<span className="block font-medium mb-1">
										{t("settings:codeIndex.gitSearchMinScoreLabel")}
									</span>
									<div className="flex items-center gap-2">
										<Slider
											min={0}
											max={1}
											step={0.01}
											value={[gitSearchMinScore]}
											onValueChange={([value]) =>
												updateGitSetting("codebaseIndexGitSearchMinScore", value)
											}
										/>
										<span className="w-12 text-center">{gitSearchMinScore.toFixed(2)}</span>
									</div>
								</SearchableSetting>

								{/* Search Max Results */}
								<SearchableSetting
									settingId="codebaseIndex-git-search-max-results"
									section="codebaseIndex"
									label={t("settings:codeIndex.gitSearchMaxResultsLabel")}>
									<span className="block font-medium mb-1">
										{t("settings:codeIndex.gitSearchMaxResultsLabel")}
									</span>
									<div className="flex items-center gap-2">
										<Slider
											min={1}
											max={50}
											step={1}
											value={[gitSearchMaxResults]}
											onValueChange={([value]) =>
												updateGitSetting("codebaseIndexGitSearchMaxResults", value)
											}
										/>
										<span className="w-12 text-center">{gitSearchMaxResults}</span>
									</div>
								</SearchableSetting>
							</>
						)}
					</div>
				</div>

				{/* ── Danger Zone ──
				    Destructive actions moved out of the popover (per UX feedback).
				    Each Clear posts directly to the host — no cachedState round-trip —
				    because both operations are immediate and side-effecting on the
				    Qdrant collection / on-disk cache, not config edits. */}
				<div>
					<h3 className="text-base font-semibold mb-3 text-vscode-errorForeground">
						{t("settings:codeIndex.dangerZoneTitle")}
					</h3>
					<div className="flex flex-wrap gap-2">
						<AlertDialog>
							<AlertDialogTrigger asChild>
								<Button variant="secondary">{t("settings:codeIndex.clearIndexDataButton")}</Button>
							</AlertDialogTrigger>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>{t("settings:codeIndex.clearDataDialog.title")}</AlertDialogTitle>
									<AlertDialogDescription>
										{t("settings:codeIndex.clearDataDialog.description")}
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>
										{t("settings:codeIndex.clearDataDialog.cancelButton")}
									</AlertDialogCancel>
									<AlertDialogAction onClick={() => vscode.postMessage({ type: "clearIndexData" })}>
										{t("settings:codeIndex.clearDataDialog.confirmButton")}
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>

						<AlertDialog>
							<AlertDialogTrigger asChild>
								<Button variant="secondary">{t("settings:codeIndex.gitClearButton")}</Button>
							</AlertDialogTrigger>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>{t("settings:codeIndex.gitClearDialog.title")}</AlertDialogTitle>
									<AlertDialogDescription>
										{t("settings:codeIndex.gitClearDialog.description")}
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>
										{t("settings:codeIndex.gitClearDialog.cancelButton")}
									</AlertDialogCancel>
									<AlertDialogAction
										onClick={() => vscode.postMessage({ type: "clearGitIndexData" })}>
										{t("settings:codeIndex.gitClearDialog.confirmButton")}
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					</div>
				</div>
			</div>
		</div>
	)
}
