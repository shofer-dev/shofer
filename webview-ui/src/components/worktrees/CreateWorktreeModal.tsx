import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import prettyBytes from "pretty-bytes"

import type { WorktreeDefaultsResponse, BranchInfo, WorktreeIncludeStatus } from "@shofer/types"

import { vscode } from "@/utils/vscode"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Button, Input } from "@/components/ui"
import { Checkbox } from "@/components/ui/checkbox"
import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select"
import { CornerDownRight, Folder, Info } from "lucide-react"

interface CreateWorktreeModalProps {
	open: boolean
	onClose: () => void
	openAfterCreate?: boolean
	onSuccess?: (createdPath?: string) => void
}

export const CreateWorktreeModal = ({
	open,
	onClose,
	openAfterCreate = false,
	onSuccess,
}: CreateWorktreeModalProps) => {
	const { t } = useAppTranslation()

	// Form state (must be declared before refs that reference them)
	const [branchName, setBranchName] = useState("")
	const [worktreePath, setWorktreePath] = useState("")
	const [baseBranch, setBaseBranch] = useState("")

	// Store latest callbacks and values in refs to avoid re-registering
	// the event listener on every parent re-render. This prevents race
	// conditions where the worktreeResult message is dropped during the
	// brief window between cleanup and re-setup of the event listener.
	const onSuccessRef = useRef(onSuccess)
	onSuccessRef.current = onSuccess
	const onCloseRef = useRef(onClose)
	onCloseRef.current = onClose
	const openAfterCreateRef = useRef(openAfterCreate)
	openAfterCreateRef.current = openAfterCreate
	const worktreePathRef = useRef(worktreePath)
	worktreePathRef.current = worktreePath
	const branchNameRef = useRef(branchName)
	branchNameRef.current = branchName

	// Data state
	const [defaults, setDefaults] = useState<WorktreeDefaultsResponse | null>(null)
	const [branches, setBranches] = useState<BranchInfo | null>(null)
	const [includeStatus, setIncludeStatus] = useState<WorktreeIncludeStatus | null>(null)

	// Stable prefix for worktree path derivation: when the user edits the
	// branch name, we rebuild the path as <prefix>/<branchName> so the
	// directory basename and branch name stay in lock-step. Captured once
	// from the defaults response.
	const [conventionPrefix, setConventionPrefix] = useState<string | null>(null)

	// UI state
	const [isCreating, setIsCreating] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [initSubmodules, setInitSubmodules] = useState(true)
	const [copyWorktreeInclude, setCopyWorktreeInclude] = useState(true)
	const [copyProgress, setCopyProgress] = useState<{
		bytesCopied: number
		itemName: string
	} | null>(null)

	// Fetch defaults and branches on open
	useEffect(() => {
		if (open) {
			vscode.postMessage({ type: "getWorktreeDefaults" })
			vscode.postMessage({ type: "getAvailableBranches" })
			vscode.postMessage({ type: "getWorktreeIncludeStatus" })
		}
	}, [open])

	// Handle messages from extension
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			switch (message.type) {
				case "worktreeDefaults": {
					const data = message as WorktreeDefaultsResponse
					setDefaults(data)
					setBranchName(data.suggestedBranch)
					setWorktreePath(data.suggestedPath)
					// Capture the parent directory of the suggested path as the
					// stable convention prefix (<workspace>/.shofer/worktrees/)
					// so the path can be rebuilt when the user edits the branch.
					const sep = data.suggestedPath.includes("\\") ? "\\" : "/"
					const lastSep = data.suggestedPath.lastIndexOf(sep)
					if (lastSep !== -1) {
						setConventionPrefix(data.suggestedPath.substring(0, lastSep))
					}
					break
				}
				case "branchList": {
					const data = message as BranchInfo
					setBranches(data)
					setBaseBranch(data.currentBranch || "main")
					break
				}
				case "worktreeIncludeStatus": {
					setIncludeStatus(message.worktreeIncludeStatus)
					break
				}
				// Removed "folderSelected" handler — worktree paths are
				// auto-generated under .shofer/worktrees/ (embedded convention).
				// The user cannot choose an arbitrary path.
				case "worktreeCopyProgress": {
					setCopyProgress({
						bytesCopied: message.copyProgressBytesCopied ?? 0,
						itemName: message.copyProgressItemName ?? "",
					})
					break
				}
				case "worktreeResult": {
					setIsCreating(false)
					setCopyProgress(null)
					if (message.success) {
						// Embedded worktree: spawn an empty parallel task scoped to
						// the worktree directory instead of opening a separate VS
						// Code window.  The task's cwd is the worktree path; the
						// branch context is communicated via the task name (and
						// surfaced in TaskHeader/TaskSelector via the worktree
						// badge), not as a synthesized "user" message — that would
						// pollute the conversation history.
						if (openAfterCreateRef.current) {
							vscode.postMessage({
								type: "createParallelTask",
								worktreeDir: worktreePathRef.current,
								taskName: `worktree: ${branchNameRef.current}`,
							})
						}
						// Forward the created worktree path to onSuccess so callers
						// can auto-select the newly created worktree.
						const createdPath = message.worktree?.path ?? worktreePathRef.current
						onSuccessRef.current?.(createdPath)
						onCloseRef.current()
					} else {
						setError(message.text || "Unknown error")
					}
					break
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	// Sync worktree path to branch name: whenever the user types a new branch
	// name, update the worktree directory basename to match. This ensures the
	// directory name and branch name stay in lock-step so there is one name to
	// track across the branch, filesystem, and UI badge.
	useEffect(() => {
		if (!conventionPrefix || !branchName.trim()) return
		const newPath = `${conventionPrefix}/${branchName}`
		if (newPath !== worktreePath) {
			setWorktreePath(newPath)
		}
	}, [branchName, conventionPrefix, worktreePath])

	const handleCreate = useCallback(() => {
		setError(null)
		setIsCreating(true)

		vscode.postMessage({
			type: "createWorktree",
			worktreePath: worktreePath,
			worktreeBranch: branchName,
			worktreeBaseBranch: baseBranch,
			worktreeCreateNewBranch: true,
			initSubmodules,
			copyWorktreeInclude,
		})
	}, [worktreePath, branchName, baseBranch, initSubmodules, copyWorktreeInclude])

	const isValid = branchName.trim() && worktreePath.trim() && baseBranch.trim()

	// Convert branches to SearchableSelect options format
	const branchOptions = useMemo((): SearchableSelectOption[] => {
		if (!branches) return []

		const localOptions: SearchableSelectOption[] = branches.localBranches.map((branch) => ({
			value: branch,
			label: branch,
			icon: <span className="codicon codicon-git-branch mr-2 text-vscode-descriptionForeground" />,
		}))

		const remoteOptions: SearchableSelectOption[] = branches.remoteBranches.map((branch) => ({
			value: branch,
			label: branch,
			icon: <span className="codicon codicon-cloud mr-2 text-vscode-descriptionForeground" />,
		}))

		return [...localOptions, ...remoteOptions]
	}, [branches])

	return (
		<Dialog open={open} onOpenChange={(isOpen: boolean) => !isOpen && onClose()}>
			{/* Sit above the TaskSelector slide-in panel (z-50): this modal opens from
			    the worktree `+` while that panel may be open, so overlay + content are
			    bumped to z-[60]. The internal SearchableSelect is absolute-positioned
			    inside the content, so its dropdown rides along correctly. */}
			<DialogContent className="max-w-lg z-[60]" overlayClassName="z-[60]">
				<DialogHeader>
					<DialogTitle>{t("worktrees:createWorktree")}</DialogTitle>
				</DialogHeader>

				<div className="flex flex-col gap-3">
					{/* No .worktreeinclude warning - shows when the current worktree doesn't have .worktreeinclude */}
					{includeStatus?.exists === false && (
						<div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-vscode-inputValidation-warningBackground border border-vscode-inputValidation-warningBorder text-sm">
							<Info />
							<span className="text-vscode-foreground">
								<span className="font-medium">{t("worktrees:noIncludeFileWarning")}</span>
								{" — "}
								<span className="text-vscode-descriptionForeground">
									{t("worktrees:noIncludeFileHint")}
								</span>
							</span>
						</div>
					)}

					{/* Base branch selector */}
					<div className="flex flex-col gap-1">
						<label className="text-sm text-vscode-foreground">{t("worktrees:baseBranch")}</label>
						{!branches ? (
							<div className="flex items-center gap-2 h-8 px-2 text-sm text-vscode-descriptionForeground">
								<span className="codicon codicon-loading codicon-modifier-spin" />
								<span>{t("worktrees:loadingBranches")}</span>
							</div>
						) : (
							<SearchableSelect
								value={baseBranch}
								onValueChange={setBaseBranch}
								options={branchOptions}
								placeholder={t("worktrees:selectBranch")}
								searchPlaceholder={t("worktrees:searchBranch")}
								emptyMessage={t("worktrees:noBranchFound")}
							/>
						)}
					</div>

					{/* Branch name */}
					<div className="flex items-center gap-2">
						<CornerDownRight className="size-4 ml-2 shrink-0" />
						<label className="text-sm text-vscode-foreground shrink-0">{t("worktrees:branchName")}</label>
						<Input
							value={branchName}
							onChange={(e) => setBranchName(e.target.value)}
							placeholder={defaults?.suggestedBranch || "worktree/feature-name"}
							className="rounded-full"
						/>
					</div>

					{/* Worktree path (auto-generated under .shofer/worktrees/, not user-editable) */}
					<div className="flex items-center gap-2">
						<Folder className="size-4 ml-2 shrink-0" />
						<label className="text-sm text-vscode-foreground shrink-0">{t("worktrees:worktreePath")}</label>
						<Input
							value={worktreePath}
							readOnly
							className="rounded-full flex-1 bg-vscode-input-background opacity-80 cursor-default"
							tabIndex={-1}
						/>
					</div>

					{/* Options checkboxes */}
					<div className="flex flex-col gap-2 ml-8">
						<label className="flex items-center gap-2 cursor-pointer">
							<Checkbox
								checked={initSubmodules}
								onCheckedChange={(checked) => setInitSubmodules(checked === true)}
								disabled={isCreating}
							/>
							<span className="text-sm text-vscode-foreground">{t("worktrees:initSubmodules")}</span>
						</label>
						<label className="flex items-center gap-2 cursor-pointer">
							<Checkbox
								checked={copyWorktreeInclude}
								onCheckedChange={(checked) => setCopyWorktreeInclude(checked === true)}
								disabled={isCreating}
							/>
							<span className="text-sm text-vscode-foreground">{t("worktrees:copyWorktreeInclude")}</span>
						</label>
					</div>

					{/* Error message */}
					{error && (
						<div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-vscode-inputValidation-errorBackground border border-vscode-inputValidation-errorBorder text-sm">
							<span className="codicon codicon-error text-vscode-errorForeground flex-shrink-0" />
							<p className="text-vscode-errorForeground">{error}</p>
						</div>
					)}

					{/* Progress section - appears during file copying */}
					{copyProgress && (
						<div className="flex flex-col gap-2 px-3 py-3 rounded-lg bg-vscode-editor-background border border-vscode-panel-border">
							<div className="flex items-center gap-2 text-sm">
								<span className="codicon codicon-loading codicon-modifier-spin text-vscode-button-background" />
								<span className="text-vscode-foreground font-medium">
									{t("worktrees:copyingFiles")}
								</span>
							</div>
							<div className="text-xs text-vscode-descriptionForeground truncate">
								{t("worktrees:copyingProgress", {
									item: copyProgress.itemName,
									copied: prettyBytes(copyProgress.bytesCopied),
								})}
							</div>
						</div>
					)}
				</div>

				<DialogFooter>
					<Button variant="secondary" onClick={onClose} disabled={isCreating}>
						{t("worktrees:cancel")}
					</Button>
					<Button variant="primary" onClick={handleCreate} disabled={!isValid || isCreating}>
						{isCreating ? (
							<>
								<span className="codicon codicon-loading codicon-modifier-spin mr-2" />
								{t("worktrees:creating")}
							</>
						) : (
							t("worktrees:create")
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
