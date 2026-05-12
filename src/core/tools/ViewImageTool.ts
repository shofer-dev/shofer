/**
 * ViewImageTool - Reads and returns an image file for visual analysis.
 *
 * Supports common image formats: PNG, JPG, JPEG, GIF, BMP, SVG, WEBP.
 * Returns the image as a base64-encoded data URI.
 */

import * as path from "path"
import * as fs from "fs/promises"
import { Anthropic } from "@anthropic-ai/sdk"

import { type ShoferSayTool } from "@shofer/types"

import { Task } from "../task/Task"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import type { ToolUse, ToolResponse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface ViewImageParams {
	filePath: string
}

const SUPPORTED_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp"]

/**
 * Gets the MIME type for an image file extension.
 */
function getImageMimeType(ext: string): Anthropic.ImageBlockParam.Source["media_type"] | null {
	const normalized = ext.toLowerCase()
	switch (normalized) {
		case ".png":
			return "image/png"
		case ".jpg":
		case ".jpeg":
			return "image/jpeg"
		case ".gif":
			return "image/gif"
		case ".webp":
			return "image/webp"
		default:
			return null
	}
}

export class ViewImageTool extends BaseTool<"view_image"> {
	readonly name = "view_image" as const

	async execute(params: ViewImageParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { filePath } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			if (!filePath) {
				task.consecutiveMistakeCount++
				task.recordToolError("view_image")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("view_image", "filePath"))
				return
			}

			task.consecutiveMistakeCount = 0

			const ext = path.extname(filePath).toLowerCase()
			if (!SUPPORTED_EXTENSIONS.includes(ext)) {
				task.recordToolError("view_image")
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					`Unsupported image format: ${ext}. Supported formats: ${SUPPORTED_EXTENSIONS.join(", ")}`,
				)
				return
			}

			const absolutePath = path.resolve(task.cwd, filePath)
			const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

			const sharedMessageProps: ShoferSayTool = {
				tool: "viewImage",
				path: getReadablePath(task.cwd, filePath),
				isOutsideWorkspace,
			}

			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: `Viewing image: ${filePath}`,
			} satisfies ShoferSayTool)

			const didApprove = await askApproval("tool", completeMessage)

			if (!didApprove) {
				return
			}

			// Read the image file
			const imageBuffer = await fs.readFile(absolutePath)
			const base64Data = imageBuffer.toString("base64")

			// Get MIME type
			const mimeType = getImageMimeType(ext)

			if (mimeType) {
				// Return as image block for multimodal models
				const imageBlock: Anthropic.ImageBlockParam = {
					type: "image",
					source: {
						type: "base64",
						media_type: mimeType,
						data: base64Data,
					},
				}
				const textBlock: Anthropic.TextBlockParam = {
					type: "text",
					text: `Image file: ${filePath}`,
				}
				pushToolResult([textBlock, imageBlock] as ToolResponse)
			} else {
				// For unsupported MIME types (like SVG, BMP), return as text with base64
				pushToolResult(`Image file: ${filePath}\nBase64 data: data:image/${ext.slice(1)};base64,${base64Data}`)
			}
		} catch (error) {
			await handleError("viewing image", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"view_image">): Promise<void> {
		const filePath: string | undefined = block.params.path

		if (!this.hasPathStabilized(filePath)) {
			return
		}

		const absolutePath = filePath ? path.resolve(task.cwd, filePath) : task.cwd
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)

		const sharedMessageProps: ShoferSayTool = {
			tool: "viewImage",
			path: getReadablePath(task.cwd, filePath ?? ""),
			isOutsideWorkspace,
		}

		const partialMessage = JSON.stringify({ ...sharedMessageProps, content: "" } satisfies ShoferSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const viewImageTool = new ViewImageTool()
