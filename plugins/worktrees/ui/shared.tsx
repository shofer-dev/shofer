/**
 * Pieces both worktree UI bundles need: the scoped host API, the plugin's wire shapes,
 * and the two dialogs (create / delete).
 *
 * Bundled into `ui/indicator.js` and `ui/settings.js` separately — each entry is a
 * standalone ESM module the webview imports, so there is no third "vendor" chunk to
 * ship. React and `@shofer/plugin-ui` stay external in both.
 *
 * # Why every request is `local:`
 *
 * A worktree is a directory in **this** machine's workspace. Without the prefix, a
 * request made while a remote-executor task is focused would be answered by that
 * executor — listing its checkout, and creating worktrees on it — for a panel that
 * manages the repository the user has open here. The prefix pins them (see
 * `resolvePluginRequestTarget` in the host).
 */

import { useCallback, useEffect, useRef, useState } from "react"

import {
	Button,
	Checkbox,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	SearchableSelect,
	usePluginTranslation,
	type PluginTranslate,
	type SearchableSelectOption,
} from "@shofer/plugin-ui"

import type {
	BranchInfo,
	Worktree,
	WorktreeDefaultsResponse,
	WorktreeIncludeStatus,
	WorktreeListResponse,
	WorktreeResult,
} from "../src/types.js"

export type { BranchInfo, Worktree, WorktreeIncludeStatus, WorktreeListResponse, WorktreeResult }

/** The restricted API the host hands a plugin UI component (`PluginUIApi` in `@shofer/types`). */
export interface PluginUIApi {
	postMessage(message: unknown): void
	onMessage(listener: (message: unknown) => void): () => void
	request(method: string, params?: unknown, opts?: { mutates?: boolean }): Promise<unknown>
	readonly context: {
		readonly region: string
		readonly pluginName: string
		readonly task?: {
			readonly taskId?: string
			readonly messageCount?: number
			/** The directory the active task runs in — the worktree it is editing. */
			readonly cwd?: string
			/** Whether the host would still accept a re-point (`ctx.task.setCwd`). */
			readonly cwdMutable?: boolean
		}
	}
}

/** Call a plugin method on the host that owns the workspace. */
export function ask<T>(api: PluginUIApi, method: string, params?: unknown, mutates = false): Promise<T> {
	return api.request(`local:${method}`, params, { mutates }) as Promise<T>
}

/** Copy progress is bytes, and bytes are unreadable; keep it to three significant figures. */
export function formatBytes(bytes: number): string {
	const units = ["B", "kB", "MB", "GB", "TB"]
	let value = bytes
	let unit = 0
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000
		unit++
	}
	return `${unit === 0 ? value : value.toPrecision(3)} ${units[unit]}`
}

/** The name to show for a worktree: its branch, or why it has none. */
export function worktreeLabel(worktree: Worktree, t: PluginTranslate): string {
	if (worktree.branch) return worktree.branch
	return worktree.isDetached ? t("view.detachedHead") : t("view.noBranch")
}

/** Message the plugin pushes while a create is running (`worktrees:step`). */
interface StepMessage {
	type: "worktrees:step"
	name: string
	detail?: string
}

/** Byte-by-byte progress while `.shofer/worktreeinclude` entries are copied. */
interface CopyProgressMessage {
	type: "worktrees:copy-progress"
	bytesCopied?: number
	itemName?: string
}

export interface CreationStep {
	step: string
	detail?: string
	completed: boolean
}

/**
 * Subscribe to the plugin's creation progress.
 *
 * Both surfaces need it: the modal renders the byte counter, and the chat indicator
 * renders the step list while its popover is open.
 */
export function useCreationProgress(api: PluginUIApi): {
	steps: CreationStep[]
	copy: { bytesCopied: number; itemName: string } | null
	reset: () => void
} {
	const [steps, setSteps] = useState<CreationStep[]>([])
	const [copy, setCopy] = useState<{ bytesCopied: number; itemName: string } | null>(null)

	useEffect(
		() =>
			api.onMessage((raw) => {
				const message = raw as StepMessage | CopyProgressMessage | undefined
				if (message?.type === "worktrees:step") {
					const { name, detail } = message
					setSteps((previous) => {
						// A terminal detail closes the step it names; anything else opens a new one.
						if (detail === "done" || detail === "skipped" || detail?.startsWith("failed")) {
							return previous.map((s) => (s.step === name ? { ...s, detail, completed: true } : s))
						}
						return previous.some((s) => s.step === name)
							? previous
							: [...previous, { step: name, detail, completed: false }]
					})
				}
				if (message?.type === "worktrees:copy-progress") {
					setCopy({ bytesCopied: message.bytesCopied ?? 0, itemName: message.itemName ?? "" })
				}
			}),
		[api],
	)

	const reset = useCallback(() => {
		setSteps([])
		setCopy(null)
	}, [])

	return { steps, copy, reset }
}

/**
 * Create a worktree: pick a base branch, name the new branch, choose whether to seed it.
 *
 * The directory is derived from the branch name and shown read-only — the embedded
 * convention (`<workspace>/.worktrees/<branch>`) is what makes branch, directory
 * and badge one name the user can follow, and the plugin re-imposes it server-side
 * anyway.
 */
export function CreateWorktreeDialog({
	api,
	open,
	onClose,
	onCreated,
}: {
	api: PluginUIApi
	open: boolean
	onClose: () => void
	onCreated?: (createdPath: string, branch: string) => void
}): React.JSX.Element {
	const t = usePluginTranslation()
	const { copy, reset } = useCreationProgress(api)

	const [branchName, setBranchName] = useState("")
	const [worktreePath, setWorktreePath] = useState("")
	const [baseBranch, setBaseBranch] = useState("")
	const [defaults, setDefaults] = useState<WorktreeDefaultsResponse | null>(null)
	const [branches, setBranches] = useState<BranchInfo | null>(null)
	const [includeStatus, setIncludeStatus] = useState<WorktreeIncludeStatus | null>(null)
	const [conventionPrefix, setConventionPrefix] = useState<string | null>(null)
	const [isCreating, setIsCreating] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [initSubmodules, setInitSubmodules] = useState(true)
	const [copyWorktreeInclude, setCopyWorktreeInclude] = useState(true)

	useEffect(() => {
		if (!open) return
		let cancelled = false
		reset()
		setError(null)
		void (async () => {
			try {
				const [suggested, available, include] = await Promise.all([
					ask<WorktreeDefaultsResponse>(api, "defaults"),
					ask<BranchInfo>(api, "branches"),
					ask<WorktreeIncludeStatus>(api, "include-status"),
				])
				if (cancelled) return
				setDefaults(suggested)
				setBranchName(suggested.suggestedBranch)
				setWorktreePath(suggested.suggestedPath)
				// The parent of the suggested path is the convention prefix; keep it so the
				// directory can be rebuilt whenever the user retypes the branch.
				const separator = suggested.suggestedPath.includes("\\") ? "\\" : "/"
				const lastSeparator = suggested.suggestedPath.lastIndexOf(separator)
				if (lastSeparator !== -1) setConventionPrefix(suggested.suggestedPath.slice(0, lastSeparator))
				setBranches(available)
				setBaseBranch(available.currentBranch || "main")
				setIncludeStatus(include)
			} catch (loadError) {
				if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError))
			}
		})()
		return () => {
			cancelled = true
		}
	}, [api, open, reset])

	// Directory basename tracks the branch name, so the two never diverge.
	useEffect(() => {
		if (!conventionPrefix || !branchName.trim()) return
		const next = `${conventionPrefix}/${branchName}`
		setWorktreePath((current) => (current === next ? current : next))
	}, [branchName, conventionPrefix])

	const handleCreate = useCallback(async () => {
		setError(null)
		setIsCreating(true)
		try {
			const result = await ask<WorktreeResult>(
				api,
				"create",
				{
					path: worktreePath,
					branch: branchName,
					baseBranch,
					createNewBranch: true,
					initSubmodules,
					copyWorktreeInclude,
				},
				true,
			)
			if (!result.success) {
				setError(result.message || "Unknown error")
				return
			}
			onCreated?.(result.worktree?.path ?? worktreePath, result.worktree?.branch ?? branchName)
			onClose()
		} catch (createError) {
			setError(createError instanceof Error ? createError.message : String(createError))
		} finally {
			setIsCreating(false)
			reset()
		}
	}, [api, worktreePath, branchName, baseBranch, initSubmodules, copyWorktreeInclude, onCreated, onClose, reset])

	const branchOptions: SearchableSelectOption[] = branches
		? [
				...branches.localBranches.map((branch) => ({
					value: branch,
					label: branch,
					icon: <span className="codicon codicon-git-branch mr-2 text-vscode-descriptionForeground" />,
				})),
				...branches.remoteBranches.map((branch) => ({
					value: branch,
					label: branch,
					icon: <span className="codicon codicon-cloud mr-2 text-vscode-descriptionForeground" />,
				})),
			]
		: []

	const isValid = Boolean(branchName.trim() && worktreePath.trim() && baseBranch.trim())

	return (
		<Dialog open={open} onOpenChange={(isOpen: boolean) => !isOpen && onClose()}>
			{/* Above the task panel (z-50): this dialog opens from the chat input while that
			    panel may be showing. */}
			<DialogContent className="max-w-lg z-[60]" overlayClassName="z-[60]">
				<DialogHeader>
					<DialogTitle>{t("create.title")}</DialogTitle>
				</DialogHeader>

				<div className="flex flex-col gap-3">
					{includeStatus?.exists === false && (
						<div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-vscode-inputValidation-warningBackground border border-vscode-inputValidation-warningBorder text-sm">
							<span className="codicon codicon-info shrink-0" />
							<span className="text-vscode-foreground">
								<span className="font-medium">{t("create.noIncludeFileWarning")}</span>
								{" — "}
								<span className="text-vscode-descriptionForeground">
									{t("create.noIncludeFileHint")}
								</span>
							</span>
						</div>
					)}

					<div className="flex flex-col gap-1">
						<label className="text-sm text-vscode-foreground">{t("create.baseBranch")}</label>
						{!branches ? (
							<div className="flex items-center gap-2 h-8 px-2 text-sm text-vscode-descriptionForeground">
								<span className="codicon codicon-loading codicon-modifier-spin" />
								<span>{t("create.loadingBranches")}</span>
							</div>
						) : (
							<SearchableSelect
								value={baseBranch}
								onValueChange={setBaseBranch}
								options={branchOptions}
								placeholder={t("create.selectBranch")}
								searchPlaceholder={t("create.searchBranch")}
								emptyMessage={t("create.noBranchFound")}
							/>
						)}
					</div>

					<div className="flex items-center gap-2">
						<span className="codicon codicon-arrow-small-right ml-2 shrink-0" />
						<label className="text-sm text-vscode-foreground shrink-0">{t("create.branchName")}</label>
						<Input
							value={branchName}
							onChange={(e) => setBranchName(e.target.value)}
							placeholder={defaults?.suggestedBranch || "worktree/feature-name"}
							className="rounded-full"
						/>
					</div>

					<div className="flex items-center gap-2">
						<span className="codicon codicon-folder ml-2 shrink-0" />
						<label className="text-sm text-vscode-foreground shrink-0">{t("create.worktreePath")}</label>
						<Input
							value={worktreePath}
							readOnly
							className="rounded-full flex-1 bg-vscode-input-background opacity-80 cursor-default"
							tabIndex={-1}
						/>
					</div>

					<div className="flex flex-col gap-2 ml-8">
						<label className="flex items-center gap-2 cursor-pointer">
							<Checkbox
								checked={initSubmodules}
								onCheckedChange={(checked) => setInitSubmodules(checked === true)}
								disabled={isCreating}
							/>
							<span className="text-sm text-vscode-foreground">{t("create.initSubmodules")}</span>
						</label>
						<label className="flex items-center gap-2 cursor-pointer">
							<Checkbox
								checked={copyWorktreeInclude}
								onCheckedChange={(checked) => setCopyWorktreeInclude(checked === true)}
								disabled={isCreating}
							/>
							<span className="text-sm text-vscode-foreground">{t("create.copyWorktreeInclude")}</span>
						</label>
					</div>

					{error && (
						<div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-vscode-inputValidation-errorBackground border border-vscode-inputValidation-errorBorder text-sm">
							<span className="codicon codicon-error text-vscode-errorForeground shrink-0" />
							<p className="text-vscode-errorForeground">{error}</p>
						</div>
					)}

					{copy && (
						<div className="flex flex-col gap-2 px-3 py-3 rounded-lg bg-vscode-editor-background border border-vscode-panel-border">
							<div className="flex items-center gap-2 text-sm">
								<span className="codicon codicon-loading codicon-modifier-spin text-vscode-button-background" />
								<span className="text-vscode-foreground font-medium">{t("create.copyingFiles")}</span>
							</div>
							<div className="text-xs text-vscode-descriptionForeground truncate">
								{t("create.copyingProgress", {
									item: copy.itemName,
									copied: formatBytes(copy.bytesCopied),
								})}
							</div>
						</div>
					)}
				</div>

				<DialogFooter>
					<Button variant="secondary" onClick={onClose} disabled={isCreating}>
						{t("common.cancel")}
					</Button>
					<Button variant="primary" onClick={() => void handleCreate()} disabled={!isValid || isCreating}>
						{isCreating ? (
							<>
								<span className="codicon codicon-loading codicon-modifier-spin mr-2" />
								{t("create.creating")}
							</>
						) : (
							t("create.create")
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

/**
 * Delete a worktree — and, with it, the branch and everything uncommitted in it. The
 * warning is spelled out because `git worktree remove` is not undoable and the files
 * are not in any commit.
 */
export function DeleteWorktreeDialog({
	api,
	worktree,
	open,
	onClose,
	onDeleted,
}: {
	api: PluginUIApi
	worktree: Worktree
	open: boolean
	onClose: () => void
	onDeleted?: () => void
}): React.JSX.Element {
	const t = usePluginTranslation()
	const [isDeleting, setIsDeleting] = useState(false)
	const [forceDeleteLocked, setForceDeleteLocked] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const handleDelete = useCallback(async () => {
		setError(null)
		setIsDeleting(true)
		try {
			// Force is the norm — the user has just confirmed a destructive dialog. A LOCKED
			// worktree is the exception: the lock is a second, deliberate "not this one".
			const force = worktree.isLocked ? forceDeleteLocked : true
			const result = await ask<WorktreeResult>(api, "delete", { path: worktree.path, force }, true)
			if (!result.success) {
				setError(result.message || "Unknown error")
				return
			}
			onDeleted?.()
			onClose()
		} catch (deleteError) {
			setError(deleteError instanceof Error ? deleteError.message : String(deleteError))
		} finally {
			setIsDeleting(false)
		}
	}, [api, worktree.path, worktree.isLocked, forceDeleteLocked, onDeleted, onClose])

	return (
		<Dialog open={open} onOpenChange={(isOpen: boolean) => !isOpen && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("delete.title")}</DialogTitle>
				</DialogHeader>

				<div className="flex flex-col gap-3 overflow-hidden">
					<div className="flex flex-col p-5 gap-2 cursor-default rounded-xl text-vscode-foreground bg-vscode-input-background">
						<p className="flex items-center gap-2 m-0">
							<span className="codicon codicon-git-branch shrink-0" />
							<span className="font-medium truncate">{worktreeLabel(worktree, t)}</span>
						</p>
						<p className="flex items-start gap-2 m-0">
							<span className="codicon codicon-folder shrink-0" />
							<span className="m-0 text-sm font-mono font-medium text-vscode-descriptionForeground">
								{worktree.path}
							</span>
						</p>
					</div>

					<div className="flex items-start gap-2 px-5 py-2">
						<span className="codicon codicon-warning text-vscode-charts-yellow shrink-0" />
						<div className="flex flex-col min-w-0 gap-2">
							<p className="m-0 text-vscode-foreground">{t("delete.warning")}</p>
							<ul className="m-0 pl-0 list-none space-y-1 text-vscode-descriptionForeground">
								<li>• {t("delete.warningBranch")}</li>
								<li>• {t("delete.warningFiles")}</li>
							</ul>
							<p className="m-0 text-vscode-descriptionForeground">{t("delete.noticeLarge")}</p>
						</div>
					</div>

					{worktree.isLocked && (
						<div className="flex items-center gap-2">
							<Checkbox
								checked={forceDeleteLocked}
								onCheckedChange={(checked) => setForceDeleteLocked(checked === true)}
							/>
							<label className="text-sm text-vscode-foreground cursor-pointer">
								{t("delete.force")}
								<span className="text-vscode-descriptionForeground ml-1">({t("delete.isLocked")})</span>
							</label>
						</div>
					)}

					{error && (
						<div className="flex items-center gap-2 px-2 py-1.5 rounded bg-vscode-inputValidation-errorBackground border border-vscode-inputValidation-errorBorder text-sm">
							<span className="codicon codicon-error text-vscode-errorForeground shrink-0" />
							<p className="text-vscode-errorForeground">{error}</p>
						</div>
					)}
				</div>

				<DialogFooter>
					<Button variant="secondary" onClick={onClose}>
						{t("common.cancel")}
					</Button>
					<Button variant="destructive" onClick={() => void handleDelete()} disabled={isDeleting}>
						{isDeleting ? (
							<>
								<span className="codicon codicon-loading codicon-modifier-spin mr-2" />
								{t("delete.deleting")}
							</>
						) : (
							t("delete.delete")
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

/** Poll-free list loader shared by both surfaces. */
export function useWorktreeList(api: PluginUIApi): {
	listing: WorktreeListResponse | null
	error: string | null
	refresh: () => void
} {
	const [listing, setListing] = useState<WorktreeListResponse | null>(null)
	const [error, setError] = useState<string | null>(null)
	const inFlight = useRef(false)

	const refresh = useCallback(() => {
		if (inFlight.current) return
		inFlight.current = true
		void ask<WorktreeListResponse>(api, "list")
			.then((response) => {
				setListing(response)
				setError(response.error && response.isGitRepo ? response.error : null)
			})
			.catch((listError: unknown) => setError(listError instanceof Error ? listError.message : String(listError)))
			.finally(() => {
				inFlight.current = false
			})
	}, [api])

	useEffect(() => refresh(), [refresh])

	return { listing, error, refresh }
}
