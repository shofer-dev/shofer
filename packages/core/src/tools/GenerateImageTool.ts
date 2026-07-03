import path from "path"
import fs from "fs/promises"
import { pathToFileURL } from "node:url"
import {
	GenerateImageParams,
	IMAGE_GENERATION_MODEL_IDS,
	IMAGE_GENERATION_MODELS,
	getImageGenerationProvider,
} from "@shofer/types"
import { Task } from "../task/Task.js"
import { formatResponse } from "../prompts/responses.js"
import { fileExistsAtPath } from "../fs/fs.js"
import { getReadablePath } from "../path/path.js"
import { isPathOutsideWorkspace } from "../utils/pathUtils.js"
import { EXPERIMENT_IDS, experiments } from "@shofer/types"
import { OpenRouterHandler } from "../api/providers/openrouter.js"
import { BaseTool, ToolCallbacks } from "./BaseTool.js"
import { type ToolUse } from "@shofer/types"
import { type TaskProviderLike } from "../task-provider/index.js"
import { t } from "../i18n/index.js"

export class GenerateImageTool extends BaseTool<"generate_image"> {
	readonly name = "generate_image" as const

	async execute(params: GenerateImageParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { prompt, path: relPath, image: inputImagePath } = params
		const { handleError, pushToolResult, askApproval } = callbacks

		const provider = task.providerRef.deref() as TaskProviderLike | undefined
		const state = await provider?.getState()
		const isImageGenerationEnabled = experiments.isEnabled(
			state?.experiments ?? {},
			EXPERIMENT_IDS.IMAGE_GENERATION,
		)

		if (!isImageGenerationEnabled) {
			pushToolResult(
				formatResponse.toolError(
					"Image generation is an experimental feature that must be enabled in settings. Please enable 'Image Generation' in the Experimental Settings section.",
				),
			)
			return
		}

		if (!prompt) {
			task.consecutiveMistakeCount++
			task.recordToolError("generate_image")
			pushToolResult(await task.sayAndCreateMissingParamError("generate_image", "prompt"))
			return
		}

		if (!relPath) {
			task.consecutiveMistakeCount++
			task.recordToolError("generate_image")
			pushToolResult(await task.sayAndCreateMissingParamError("generate_image", "path"))
			return
		}

		const accessAllowed = task.shoferIgnoreController?.validateAccess(relPath)
		if (!accessAllowed) {
			await task.say("shoferignore_error", relPath)
			pushToolResult(formatResponse.shoferIgnoreError(relPath))
			return
		}

		let inputImageData: string | undefined
		if (inputImagePath) {
			const inputImageFullPath = path.resolve(task.cwd, inputImagePath)

			const inputImageExists = await fileExistsAtPath(inputImageFullPath)
			if (!inputImageExists) {
				await task.say("error", `Input image not found: ${getReadablePath(task.cwd, inputImagePath)}`)
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(`Input image not found: ${getReadablePath(task.cwd, inputImagePath)}`),
				)
				return
			}

			const inputImageAccessAllowed = task.shoferIgnoreController?.validateAccess(inputImagePath)
			if (!inputImageAccessAllowed) {
				await task.say("shoferignore_error", inputImagePath)
				pushToolResult(formatResponse.shoferIgnoreError(inputImagePath))
				return
			}

			try {
				const imageBuffer = await fs.readFile(inputImageFullPath)
				const imageExtension = path.extname(inputImageFullPath).toLowerCase().replace(".", "")

				const supportedFormats = ["png", "jpg", "jpeg", "gif", "webp"]
				if (!supportedFormats.includes(imageExtension)) {
					await task.say(
						"error",
						`Unsupported image format: ${imageExtension}. Supported formats: ${supportedFormats.join(", ")}`,
					)
					task.didToolFailInCurrentTurn = true
					pushToolResult(
						formatResponse.toolError(
							`Unsupported image format: ${imageExtension}. Supported formats: ${supportedFormats.join(", ")}`,
						),
					)
					return
				}

				const mimeType = imageExtension === "jpg" ? "jpeg" : imageExtension
				inputImageData = `data:image/${mimeType};base64,${imageBuffer.toString("base64")}`
			} catch (error) {
				await task.say(
					"error",
					`Failed to read input image: ${error instanceof Error ? error.message : "Unknown error"}`,
				)
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(
						`Failed to read input image: ${error instanceof Error ? error.message : "Unknown error"}`,
					),
				)
				return
			}
		}

		const isWriteProtected = task.shoferProtectedController?.isWriteProtected(relPath) || false

		// Use shared utility for backwards compatibility logic
		const imageProvider = getImageGenerationProvider(
			state?.imageGenerationProvider,
			!!state?.openRouterImageGenerationSelectedModel,
		)

		// Get the selected model
		let selectedModel = state?.openRouterImageGenerationSelectedModel
		let modelInfo = undefined

		// Find the model info matching both value AND provider
		// (since the same model value can exist for multiple providers)
		if (selectedModel) {
			modelInfo = IMAGE_GENERATION_MODELS.find((m) => m.value === selectedModel && m.provider === imageProvider)
			if (!modelInfo) {
				// Model doesn't exist for this provider, use first model for selected provider
				const providerModels = IMAGE_GENERATION_MODELS.filter((m) => m.provider === imageProvider)
				modelInfo = providerModels[0]
				selectedModel = modelInfo?.value || IMAGE_GENERATION_MODEL_IDS[0]!
			}
		} else {
			// No model selected, use first model for selected provider
			const providerModels = IMAGE_GENERATION_MODELS.filter((m) => m.provider === imageProvider)
			modelInfo = providerModels[0]
			selectedModel = modelInfo?.value || IMAGE_GENERATION_MODEL_IDS[0]
		}

		// Use the provider selection
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const modelProvider = imageProvider
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const apiMethod = modelInfo?.apiMethod

		// Validate API key for OpenRouter
		const openRouterApiKey = state?.openRouterImageApiKey

		if (imageProvider === "openrouter" && !openRouterApiKey) {
			const errorMessage = t("tools:generateImage.openRouterApiKeyRequired")
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return
		}

		const fullPath = path.resolve(task.cwd, relPath)
		const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)

		const sharedMessageProps = {
			tool: "generateImage" as const,
			path: getReadablePath(task.cwd, relPath),
			content: prompt,
			isOutsideWorkspace,
			isProtected: isWriteProtected,
		}

		try {
			task.consecutiveMistakeCount = 0

			const approvalMessage = JSON.stringify({
				...sharedMessageProps,
				content: prompt,
				...(inputImagePath && { inputImage: getReadablePath(task.cwd, inputImagePath) }),
			})

			const didApprove = await askApproval("tool", approvalMessage, undefined, isWriteProtected)

			if (!didApprove) {
				return
			}

			let result
			// Shofer provider removed; fall through to OpenRouter
			{
				// Use OpenRouter provider (only supports chat completions API)
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const openRouterHandler = new OpenRouterHandler({} as any)
				result = await openRouterHandler.generateImage(prompt, selectedModel!, openRouterApiKey!, inputImageData)
			}

			if (!result.success) {
				await task.say("error", result.error || "Failed to generate image")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(result.error || "Failed to generate image"))
				return
			}

			if (!result.imageData) {
				const errorMessage = "No image data received"
				await task.say("error", errorMessage)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(errorMessage))
				return
			}

			const base64Match = result.imageData.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/)
			if (!base64Match) {
				const errorMessage = "Invalid image format received"
				await task.say("error", errorMessage)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(errorMessage))
				return
			}

			const imageFormat = base64Match[1]
			const base64Data = base64Match[2]!

			let finalPath = relPath
			if (!finalPath.match(/\.(png|jpg|jpeg)$/i)) {
				finalPath = `${finalPath}.${imageFormat === "jpeg" ? "jpg" : imageFormat}`
			}

			const imageBuffer = Buffer.from(base64Data, "base64")

			const absolutePath = path.resolve(task.cwd, finalPath)
			const directory = path.dirname(absolutePath)
			await fs.mkdir(directory, { recursive: true })

			await fs.writeFile(absolutePath, imageBuffer)

			if (finalPath) {
				await task.fileContextTracker.trackFileContext(finalPath, "shofer_edited")
			}

			task.didEditFile = true

			task.recordToolUsage("generate_image")

			const fullImagePath = path.join(task.cwd, finalPath)

			let imageUri = provider?.convertToWebviewUri?.(fullImagePath) ?? pathToFileURL(fullImagePath).toString()

			const cacheBuster = Date.now()
			imageUri = imageUri.includes("?") ? `${imageUri}&t=${cacheBuster}` : `${imageUri}?t=${cacheBuster}`

			await task.say("image", JSON.stringify({ imageUri, imagePath: fullImagePath }))
			pushToolResult(formatResponse.toolResult(getReadablePath(task.cwd, finalPath)))
		} catch (error) {
			await handleError("generating image", error as Error)
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	override async handlePartial(task: Task, block: ToolUse<"generate_image">): Promise<void> {
		return
	}
}

export const generateImageTool = new GenerateImageTool()
