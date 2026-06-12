/**
 * SedTool — Regex find-and-replace on a workspace file, analogous to `sed 's/pattern/replacement/g'`.
 *
 * Reads the file, applies a JavaScript RegExp substitution (with optional global flag),
 * and writes the result back through the DiffViewProvider so the FileChangesPanel can
 * diff and revert the change.
 */

import * as path from "path"
import * as fs from "fs/promises"
import { type ShoferSayTool, DEFAULT_WRITE_DELAY_MS } from "@shofer/types"

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { validateWorktreePath } from "../../utils/worktreePathGuard"
import { formatResponse } from "../prompts/responses"
import { fileExistsAtPath } from "../../utils/fs"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { sanitizeUnifiedDiff } from "../diff/stats"
import { computeDiffStats } from "../diff/stats"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { taskLog } from "../../utils/logging/subsystems"

interface SedParams {
	path: string
	pattern: string
	replacement: string
	isRegex?: boolean | null
	global?: boolean
}

export class SedTool extends BaseTool<"sed"> {
	readonly name = "sed" as const

	async execute(params: SedParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const { path: relPath, pattern, replacement, isRegex: isRegexParam, global = true } = params
		// Explicit literal mode (isRegex: false) suppresses all regex escaping/fallback.
		const regexMode = isRegexParam !== false

		try {
			if (!relPath) {
				task.consecutiveMistakeCount++
				task.recordToolError("sed")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("sed", "path"))
				return
			}
			if (!pattern) {
				task.consecutiveMistakeCount++
				task.recordToolError("sed")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("sed", "pattern"))
				return
			}
			if (replacement == null) {
				task.consecutiveMistakeCount++
				task.recordToolError("sed")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("sed", "replacement"))
				return
			}

			const worktreeErr = validateWorktreePath(task, relPath)
			if (worktreeErr) {
				task.consecutiveMistakeCount++
				task.recordToolError("sed")
				task.didToolFailInCurrentTurn = true
				pushToolResult(worktreeErr)
				return
			}

			const accessAllowed = task.shoferIgnoreController?.validateAccess(relPath)

			if (!accessAllowed) {
				await task.say("shoferignore_error", relPath)
				pushToolResult(formatResponse.shoferIgnoreError(relPath))
				return
			}

			const absolutePath = path.resolve(task.cwd, relPath)
			const fileExists = await fileExistsAtPath(absolutePath)

			if (!fileExists) {
				task.consecutiveMistakeCount++
				task.recordToolError("sed")
				const formattedError = `File does not exist at path: ${absolutePath}\n\n<error_details>\nThe specified file could not be found. Please verify the file path and try again.\n</error_details>`
				await task.say("error", formattedError)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formattedError)
				return
			}

			// Read the original content
			const originalContent = await fs.readFile(absolutePath, "utf-8")

			// Detect regex metacharacters for literal fallback logic below.
			const METACHAR_REGEX = /[.*+?^${}()|[\]\\]/

			// Compile the regex; if regexMode is false, skip regex entirely
			// and build a literal regex from the escaped pattern directly.
			let regex: RegExp
			let matchSource: "regex" | "literal" = "regex"
			if (!regexMode) {
				// Literal mode — escape all metacharacters and compile immediately.
				const escaped = pattern.replace(METACHAR_REGEX, "\\$&")
				try {
					regex = new RegExp(escaped, global ? "g" : "")
				} catch (literalErr) {
					task.consecutiveMistakeCount++
					task.recordToolError("sed")
					const formattedError = `Invalid literal pattern (could not compile as regex even after escaping): ${pattern}\n\n<error_details>\n${literalErr instanceof Error ? literalErr.message : String(literalErr)}\n</error_details>`
					await task.say("error", formattedError)
					task.didToolFailInCurrentTurn = true
					pushToolResult(formattedError)
					return
				}
				matchSource = "literal"
			} else {
				try {
					const flags = global ? "g" : ""
					regex = new RegExp(pattern, flags)
				} catch (compileErr) {
					if (METACHAR_REGEX.test(pattern)) {
						try {
							const escapedPattern = pattern.replace(METACHAR_REGEX, "\\$&")
							regex = new RegExp(escapedPattern, global ? "g" : "")
							matchSource = "literal"
						} catch {
							// Literal also failed — report original compile error.
							task.consecutiveMistakeCount++
							task.recordToolError("sed")
							const formattedError = `Invalid regex pattern: ${pattern}\n\n<error_details>\n${compileErr instanceof Error ? compileErr.message : String(compileErr)}\n</error_details>`
							await task.say("error", formattedError)
							task.didToolFailInCurrentTurn = true
							pushToolResult(formattedError)
							return
						}
					} else {
						task.consecutiveMistakeCount++
						task.recordToolError("sed")
						const formattedError = `Invalid regex pattern: ${pattern}\n\n<error_details>\n${compileErr instanceof Error ? compileErr.message : String(compileErr)}\n</error_details>`
						await task.say("error", formattedError)
						task.didToolFailInCurrentTurn = true
						pushToolResult(formattedError)
						return
					}
				}
			}

			// Apply the substitution — try regex first; if zero matches and the
			// pattern contains regex metacharacters, retry as a literal string.
			// This handles cases where the model intended a literal search but
			// used characters like * . + ? ( ) [ ] { } ^ $ | \ without escaping.
			let newContent = originalContent.replace(regex, replacement)

			if (newContent === originalContent && matchSource !== "literal" && METACHAR_REGEX.test(pattern)) {
				try {
					const escapedPattern = pattern.replace(METACHAR_REGEX, "\\$&")
					const literalRegex = new RegExp(escapedPattern, global ? "g" : "")
					const literalContent = originalContent.replace(literalRegex, replacement)
					if (literalContent !== originalContent) {
						newContent = literalContent
						matchSource = "literal"
					}
				} catch {
					// Literal regex compilation failed — fall through to the no-match message.
				}
			}

			// Check if anything changed
			if (newContent === originalContent) {
				pushToolResult(`No matches found for pattern "${pattern}" in ${relPath}`)
				return
			}

			task.consecutiveMistakeCount = 0

			// Count matches using the effective regex (literal or original)
			const effectiveRegex =
				matchSource === "literal"
					? new RegExp(pattern.replace(METACHAR_REGEX, "\\$&"), global ? "g" : "")
					: regex
			const matchCount = (originalContent.match(effectiveRegex) || []).length

			// Generate backend-unified diff for display in chat/webview
			const unifiedPatchRaw = formatResponse.createPrettyPatch(relPath, originalContent, newContent)
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

			const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)
			const sharedMessageProps: ShoferSayTool = {
				tool: "editedExistingFile",
				path: getReadablePath(task.cwd, relPath),
				isOutsideWorkspace,
			}

			// Capture original content before mutation for FileChangesPanel.
			try {
				await task.fileContextTracker?.captureOriginal(relPath, originalContent)
			} catch (err) {
				taskLog.warn(`[SedTool] captureOriginal failed for ${relPath}:`, err)
			}

			if (isPreventFocusDisruptionEnabled) {
				// Direct file write without diff view
				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					content: unifiedPatch,
					diffStats,
					isProtected: isWriteProtected,
				} satisfies ShoferSayTool)

				const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

				if (!didApprove) {
					return
				}

				// Save directly without showing diff view or opening the file
				task.diffViewProvider.editType = "modify"
				task.diffViewProvider.originalContent = originalContent
				await task.diffViewProvider.saveDirectly(relPath, newContent, false, diagnosticsEnabled, writeDelayMs)
			} else {
				// Show diff view before asking for approval
				task.diffViewProvider.editType = "modify"
				await task.diffViewProvider.open(relPath)
				await task.diffViewProvider.update(newContent, true)
				task.diffViewProvider.scrollToFirstDiff()

				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					content: unifiedPatch,
					diffStats,
					isProtected: isWriteProtected,
				} satisfies ShoferSayTool)

				const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

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

			task.didEditFile = true

			// Get the formatted response message
			const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, false)

			const literalNote =
				matchSource === "literal" ? " (literal match — regex special characters were escaped)" : ""
			pushToolResult(`${matchCount} replacement(s) made${literalNote}.\n${message}`)

			await task.diffViewProvider.reset()
			this.resetPartialState()
			task.processQueuedMessages()
		} catch (error) {
			await handleError("executing sed", error instanceof Error ? error : new Error(String(error)))
			await task.diffViewProvider.reset()
			this.resetPartialState()
			task.processQueuedMessages()
			return
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"sed">): Promise<void> {
		const relPath: string | undefined = block.params.path

		if (!this.hasPathStabilized(relPath)) {
			return
		}

		const sharedMessageProps: ShoferSayTool = {
			tool: "editedExistingFile",
			path: getReadablePath(task.cwd, relPath ?? ""),
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial).catch(() => {})
	}
}

export const sedTool = new SedTool()
