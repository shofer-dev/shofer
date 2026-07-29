/**
 * Worktree management in Settings (`settings-tab`).
 *
 * Lists every worktree of the workspace repository, creates new ones, deletes the ones
 * that are finished, and offers to seed `.shofer/worktreeinclude` from `.gitignore` —
 * the file that decides which untracked things (`.env`, `node_modules`) a new checkout
 * gets so it is usable rather than merely present.
 *
 * The three "this repository cannot have worktrees" states (not a git repo, multi-root,
 * a subfolder checkout) are rendered as explanations rather than an empty list: each has
 * a different fix, and an empty list tells the user none of them.
 *
 * BUILD: `ui/settings.js` (esbuild ESM; React and `@shofer/plugin-ui` external).
 */

import { useCallback, useEffect, useState } from "react"

import { Badge, Button, StandardTooltip, cn, usePluginTranslation } from "@shofer/plugin-ui"

import {
	CreateWorktreeDialog,
	DeleteWorktreeDialog,
	ask,
	useWorktreeList,
	useWorktreesFeature,
	worktreeLabel,
	type PluginUIApi,
	type Worktree,
	type WorktreeIncludeStatus,
} from "./shared.js"

/** Matches the host's own `SectionHeader`, so the panel reads as part of Settings. */
function SectionHeader({ children }: { children: React.ReactNode }): React.JSX.Element {
	return (
		<div className="sticky top-0 z-10 text-vscode-sideBar-foreground bg-vscode-sideBar-background px-5 pt-6 pb-4">
			<h3 className="text-[1.25em] font-semibold text-vscode-foreground m-0">{children}</h3>
		</div>
	)
}

/** A repository that cannot host worktrees, and why. */
function Unavailable({ title, reason, detail }: { title: string; reason: string; detail?: React.ReactNode }) {
	return (
		<div>
			<SectionHeader>{title}</SectionHeader>
			<div className="px-5 text-sm">
				<p>{reason}</p>
				{detail}
			</div>
		</div>
	)
}

export default function WorktreesSettings({ api }: { api: PluginUIApi }): React.JSX.Element | null {
	const t = usePluginTranslation()
	const featureOn = useWorktreesFeature(api)
	const { listing, error, refresh } = useWorktreeList(api)

	const [includeStatus, setIncludeStatus] = useState<WorktreeIncludeStatus | null>(null)
	const [isCreatingInclude, setIsCreatingInclude] = useState(false)
	const [showCreate, setShowCreate] = useState(false)
	const [pendingDelete, setPendingDelete] = useState<Worktree | null>(null)

	const refreshInclude = useCallback(() => {
		void ask<WorktreeIncludeStatus>(api, "include-status")
			.then(setIncludeStatus)
			.catch(() => setIncludeStatus(null))
	}, [api])

	useEffect(() => refreshInclude(), [refreshInclude])

	const handleCreateInclude = useCallback(async () => {
		if (!includeStatus?.gitignoreContent) return
		setIsCreatingInclude(true)
		try {
			// The plugin opens the new file in the editor — the next thing the user wants is
			// to edit it, and telling them the path instead is strictly worse.
			await ask(api, "create-include", { content: includeStatus.gitignoreContent }, true)
		} finally {
			setIsCreatingInclude(false)
			refreshInclude()
		}
	}, [api, includeStatus, refreshInclude])

	const title = t("view.title")

	// The feature is off (Basics config or governance): a deployment replacing
	// worktrees must not end up with two management panels.
	if (!featureOn) return null

	if (listing && !listing.isGitRepo && listing.gitRootPath === "" && listing.error === "no-workspace") {
		return <Unavailable title={title} reason={t("view.noWorkspace")} />
	}
	if (listing?.isMultiRoot) {
		return <Unavailable title={title} reason={t("view.multiRootNotSupported")} />
	}
	if (listing && !listing.isGitRepo) {
		return <Unavailable title={title} reason={t("view.notGitRepo")} />
	}
	if (listing?.isSubfolder) {
		return (
			<Unavailable
				title={title}
				reason={t("view.subfolderNotSupported")}
				detail={
					<p>
						{t("view.gitRoot")}:{" "}
						<code className="bg-vscode-input-background p-1 rounded-md">{listing.gitRootPath}</code>
					</p>
				}
			/>
		)
	}

	return (
		<div className="flex flex-col">
			<SectionHeader>{title}</SectionHeader>
			<div className="flex flex-col gap-2 px-5 py-2">
				<p className="text-vscode-descriptionForeground text-sm m-0">{t("view.description")}</p>
				<Button variant="secondary" className="py-1" onClick={() => setShowCreate(true)}>
					<span className="codicon codicon-add mr-1" />
					{t("view.newWorktree")}
				</Button>
			</div>

			<div className="px-4 py-2">
				{!listing ? (
					<div className="flex items-center justify-center h-24">
						<span className="codicon codicon-loading codicon-modifier-spin text-2xl" />
					</div>
				) : error ? (
					<div className="flex flex-col items-center justify-center h-24 text-vscode-errorForeground">
						<span className="codicon codicon-error text-2xl mb-2" />
						<p className="text-center">{error}</p>
					</div>
				) : (
					<div className="flex flex-col gap-1">
						{listing.worktrees.map((worktree) => (
							<div
								key={worktree.path}
								className={cn(
									"p-2.5 px-3.5 rounded-xl border border-transparent",
									worktree.isCurrent
										? "bg-vscode-list-activeSelectionBackground border-vscode-list-activeSelectionForeground/20"
										: "hover:bg-vscode-list-hoverBackground",
								)}>
								<div className="flex items-center justify-between gap-2 overflow-hidden">
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2 overflow-hidden">
											<span className="codicon codicon-git-branch shrink-0" />
											<span className="font-medium truncate">{worktreeLabel(worktree, t)}</span>
											{worktree.isBare && (
												<Badge className="text-[0.7em] py-0.5">{t("view.primary")}</Badge>
											)}
											{worktree.isLocked && (
												<StandardTooltip content={worktree.lockReason || t("view.locked")}>
													<span className="codicon codicon-lock text-vscode-charts-yellow" />
												</StandardTooltip>
											)}
										</div>
										<div className="flex gap-2 text-xs text-vscode-descriptionForeground mt-1">
											<span className="codicon codicon-folder shrink-0" />
											<span className="truncate">{worktree.path}</span>
										</div>
									</div>

									<StandardTooltip content={t("delete.delete")}>
										<Button
											variant="ghost"
											size="icon"
											disabled={worktree.isCurrent || worktree.isBare}
											onClick={() => setPendingDelete(worktree)}>
											<span className="codicon codicon-trash text-vscode-errorForeground" />
										</Button>
									</StandardTooltip>
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			{includeStatus && (
				<div className="flex items-center gap-2 text-sm px-5 py-3 justify-between text-vscode-descriptionForeground border-t border-vscode-sideBar-background">
					{includeStatus.exists ? (
						<span>{t("view.includeFileExists")}</span>
					) : (
						<>
							<span>{t("view.noIncludeFile")}</span>
							{includeStatus.hasGitignore && (
								<Button
									variant="secondary"
									size="sm"
									onClick={() => void handleCreateInclude()}
									disabled={isCreatingInclude}>
									{t("view.createFromGitignore")}
								</Button>
							)}
						</>
					)}
				</div>
			)}

			<CreateWorktreeDialog
				api={api}
				open={showCreate}
				onClose={() => setShowCreate(false)}
				onCreated={() => {
					refresh()
					refreshInclude()
				}}
			/>

			{pendingDelete && (
				<DeleteWorktreeDialog
					api={api}
					worktree={pendingDelete}
					open
					onClose={() => setPendingDelete(null)}
					onDeleted={refresh}
				/>
			)}
		</div>
	)
}
