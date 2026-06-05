import path from "path"
import fs from "fs/promises"

import { type ShoferSayTool, DEFAULT_WRITE_DELAY_MS } from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

import { getReadablePath } from "../../utils/path"
import { validateWorktreePath } from "../../utils/worktreePathGuard"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { fileExistsAtPath } from "../../utils/fs"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { computeDiffStats, sanitizeUnifiedDiff } from "../diff/stats"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface ApplyDiffParams {
	path: string
	diff: string
}

export class ApplyDiffTool extends BaseTool<"apply_diff"> {
	readonly name = "apply_diff" as const

	async execute(params: ApplyDiffParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		let { path: relPath, diff: diffContent } = params

		try {
			if (!relPath) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_diff")
				pushToolResult(await task.sayAndCreateMissingParamError("apply_diff", "path"))
				return
			}

			if (!diffContent) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_diff")
				pushToolResult(await task.sayAndCreateMissingParamError("apply_diff", "diff"))
				return
			}

			const accessAllowed = task.shoferIgnoreController?.validateAccess(relPath)

			if (!accessAllowed) {
				await task.say("shoferignore_error", relPath)
				pushToolResult(formatResponse.shoferIgnoreError(relPath))
				return
			}

			const worktreeErr = validateWorktreePath(task, relPath)
			if (worktreeErr) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_diff")
				pushToolResult(worktreeErr)
				return
			}

			const absolutePath = path.resolve(task.cwd, relPath)
			const fileExists = await fileExistsAtPath(absolutePath)

			if (!fileExists) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_diff")
				const formattedError = `File does not exist at path: ${absolutePath}\n\n<error_details>\nThe specified file could not be found. Please verify the file path and try again.\n</error_details>`
				await task.say("error", formattedError)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formattedError)
				return
			}

			const originalContent: string = await fs.readFile(absolutePath, "utf-8")

			// Apply the diff to the original content
			const diffResult = (await task.diffStrategy?.applyDiff(
				originalContent,
				diffContent,
				parseInt(params.diff.match(/:start_line:(\d+)/)?.[1] ?? ""),
			)) ?? {
				success: false,
				error: "No diff strategy available",
			}

			if (!diffResult.success) {
				task.consecutiveMistakeCount++
				const currentCount = (task.consecutiveMistakeCountForApplyDiff.get(relPath) || 0) + 1
				task.consecutiveMistakeCountForApplyDiff.set(relPath, currentCount)
				let formattedError = ""
				TelemetryService.instance.captureDiffApplicationError(task.taskId, currentCount)

				if (diffResult.failParts && diffResult.failParts.length > 0) {
					for (const failPart of diffResult.failParts) {
						if (failPart.success) {
							continue
						}

						const errorDetails = failPart.details ? JSON.stringify(failPart.details, null, 2) : ""

						formattedError = `<error_details>\n${
							failPart.error
						}${errorDetails ? `\n\nDetails:\n${errorDetails}` : ""}\n</error_details>`
					}
				} else {
					const errorDetails = diffResult.details ? JSON.stringify(diffResult.details, null, 2) : ""

					formattedError = `Unable to apply diff to file: ${absolutePath}\n\n<error_details>\n${
						diffResult.error
					}${errorDetails ? `\n\nDetails:\n${errorDetails}` : ""}\n</error_details>`
				}

				if (currentCount >= 2) {
					await task.say("diff_error", formattedError)
				}

				task.recordToolError("apply_diff", formattedError)

				pushToolResult(formattedError)
				return
			}

			task.consecutiveMistakeCount = 0
			task.consecutiveMistakeCountForApplyDiff.delete(relPath)

			// Generate backend-unified diff for display in chat/webview
			const unifiedPatchRaw = formatResponse.createPrettyPatch(relPath, originalContent, diffResult.content)
			const unifiedPatch = sanitizeUnifiedDiff(unifiedPatchRaw)
			const diffStats = computeDiffStats(unifiedPatch) || undefined

			// Check if preventFocusDisruption experiment is enabled
			const provider = task.providerRef.deref()
			const state = await provider?.getState()
			const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
			const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
			const isPreventFocusDisruptionEnabled = experiments.isEnabled(
				state?.experiments ?? {},
				EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
			)

			// Check if file is write-protected
			const isWriteProtected = task.shoferProtectedController?.isWriteProtected(relPath) || false

			const sharedMessageProps: ShoferSayTool = {
				tool: "appliedDiff",
				path: getReadablePath(task.cwd, relPath),
				diff: diffContent,
			}

			if (isPreventFocusDisruptionEnabled) {
				// Direct file write without diff view
				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					diff: diffContent,
					content: unifiedPatch,
					originalContent,
					diffStats,
					isProtected: isWriteProtected,
				} satisfies ShoferSayTool)

				let toolProgressStatus

				if (task.diffStrategy && task.diffStrategy.getProgressStatus) {
					const block: ToolUse<"apply_diff"> = {
						type: "tool_use",
						name: "apply_diff",
						params: { path: relPath, diff: diffContent },
						partial: false,
					}
					toolProgressStatus = task.diffStrategy.getProgressStatus(block, diffResult)
				}

				const didApprove = await askApproval("tool", completeMessage, toolProgressStatus, isWriteProtected)

				if (!didApprove) {
					return
				}

				// Save directly without showing diff view or opening the file
				task.diffViewProvider.editType = "modify"
				task.diffViewProvider.originalContent = originalContent
				await task.diffViewProvider.saveDirectly(
					relPath,
					diffResult.content,
					false,
					diagnosticsEnabled,
					writeDelayMs,
				)
			} else {
				// Original behavior with diff view
				// Show diff view before asking for approval
				task.diffViewProvider.editType = "modify"
				await task.diffViewProvider.open(relPath)
				await task.diffViewProvider.update(diffResult.content, true)
				task.diffViewProvider.scrollToFirstDiff()

				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					diff: diffContent,
					content: unifiedPatch,
					originalContent,
					diffStats,
					isProtected: isWriteProtected,
				} satisfies ShoferSayTool)

				let toolProgressStatus

				if (task.diffStrategy && task.diffStrategy.getProgressStatus) {
					const block: ToolUse<"apply_diff"> = {
						type: "tool_use",
						name: "apply_diff",
						params: { path: relPath, diff: diffContent },
						partial: false,
					}
					toolProgressStatus = task.diffStrategy.getProgressStatus(block, diffResult)
				}

				const didApprove = await askApproval("tool", completeMessage, toolProgressStatus, isWriteProtected)

				if (!didApprove) {
					await task.diffViewProvider.revertChanges()
					task.processQueuedMessages()
					return
				}

				// Call saveChanges to update the DiffViewProvider properties
				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}

			// Track file edit operation
			if (relPath) {
				await task.fileContextTracker.trackFileContext(relPath, "shofer_edited" as RecordSource)
			}

			// Used to determine if we should wait for busy terminal to update before sending api request
			task.didEditFile = true

			// Compute block-level stats once and surface them to the model via
			// pushToolWriteResult's opaque `extra` channel. Keeping the
			// `<<<<<<< SEARCH` parsing here (the only place that owns the
			// apply_diff format) avoids leaking strategy concerns into the
			// generic DiffViewProvider used by 9 different write tools.
			const totalBlocks = (diffContent.match(/<<<<<<< SEARCH/g) || []).length
			const failedBlocks = diffResult.failParts?.filter((p) => !p.success).length ?? 0
			const appliedBlocks = totalBlocks - failedBlocks

			const extra: Parameters<typeof task.diffViewProvider.pushToolWriteResult>[3] = {}
			if (totalBlocks > 1 || failedBlocks > 0) {
				extra.summary = `${appliedBlocks}/${totalBlocks} blocks applied to ${relPath}.`
				extra.stats = {
					total_blocks: totalBlocks,
					applied_blocks: appliedBlocks,
					failed_blocks: failedBlocks,
				}
			}
			if (failedBlocks > 0) {
				extra.hint = `${failedBlocks} block(s) did not match — use read_file to verify the current file state and re-apply the failed blocks.`
			}

			// Get the formatted response message
			const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, !fileExists, extra)

			// Single-block hint: nudge the model toward batching related edits.
			const singleBlockNotice =
				totalBlocks === 1
					? "\n<notice>Making multiple related changes in a single apply_diff is more efficient. If other changes are needed in this file, please include them as additional SEARCH/REPLACE blocks.</notice>"
					: ""

			pushToolResult(message + singleBlockNotice)

			await task.diffViewProvider.reset()
			this.resetPartialState()

			// Process any queued messages after file edit completes
			task.processQueuedMessages()

			return
		} catch (error) {
			await handleError("applying diff", error as Error)
			await task.diffViewProvider.reset()
			this.resetPartialState()
			task.processQueuedMessages()
			return
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"apply_diff">): Promise<void> {
		const relPath: string | undefined = block.params.path
		const diffContent: string | undefined = block.params.diff

		// Wait for path to stabilize before showing UI (prevents truncated paths)
		if (!this.hasPathStabilized(relPath)) {
			return
		}

		const sharedMessageProps: ShoferSayTool = {
			tool: "appliedDiff",
			path: getReadablePath(task.cwd, relPath),
			diff: diffContent,
		}

		let toolProgressStatus

		if (task.diffStrategy && task.diffStrategy.getProgressStatus) {
			toolProgressStatus = task.diffStrategy.getProgressStatus(block)
		}

		if (toolProgressStatus && Object.keys(toolProgressStatus).length === 0) {
			return
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial, toolProgressStatus).catch(() => {})
	}
}

export const applyDiffTool = new ApplyDiffTool()
