import { describe, it, expect, vi, beforeEach } from "vitest"
import { generateImageTool } from "@shofer/core"
import { ToolUse } from "@shofer/core"
import { Task } from "@shofer/core"
import * as fs from "fs/promises"
import { isPathOutsideWorkspace } from "@shofer/core"
import * as fileUtils from "../../../utils/fs.js"
import { formatResponse } from "@shofer/core"
import { EXPERIMENT_IDS } from "@shofer/types"
import { OpenRouterHandler } from "@shofer/core"

// Mock dependencies
vi.mock("fs/promises")
vi.mock("../../../utils/fs")
// safeWriteJson, OpenRouterHandler and isPathOutsideWorkspace are exported from @shofer/core; partially mock them there
vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	safeWriteJson: vi.fn(),
	OpenRouterHandler: vi.fn(),
	isPathOutsideWorkspace: vi.fn(),
}))

describe("generateImageTool", () => {
	let mockShofer: any
	let mockAskApproval: any
	let mockHandleError: any
	let mockPushToolResult: any

	beforeEach(() => {
		vi.clearAllMocks()

		// Setup mock Shofer instance
		mockShofer = {
			cwd: "/test/workspace",
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			recordToolUsage: vi.fn(),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter error"),
			say: vi.fn(),
			shoferIgnoreController: {
				validateAccess: vi.fn().mockReturnValue(true),
			},
			shoferProtectedController: {
				isWriteProtected: vi.fn().mockReturnValue(false),
			},
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({
						experiments: {
							[EXPERIMENT_IDS.IMAGE_GENERATION]: true,
						},
						openRouterImageApiKey: "test-api-key",
						openRouterImageGenerationSelectedModel: "google/gemini-2.5-flash-image",
					}),
				}),
			},
			fileContextTracker: {
				trackFileContext: vi.fn(),
			},
			didEditFile: false,
		}

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn()
		mockPushToolResult = vi.fn()

		// Mock file system operations
		vi.mocked(fileUtils.fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("fake-image-data"))
		vi.mocked(fs.mkdir).mockResolvedValue(undefined)
		vi.mocked(fs.writeFile).mockResolvedValue(undefined)
		vi.mocked(isPathOutsideWorkspace).mockReturnValue(false)
	})

	describe("partial block handling", () => {
		it("should return early when block is partial", async () => {
			const partialBlock: ToolUse = {
				type: "tool_use",
				name: "generate_image",
				params: {
					prompt: "Generate a test image",
					path: "test-image.png",
				},
				nativeArgs: {
					prompt: "Generate a test image",
					path: "test-image.png",
				},
				partial: true,
			}

			await generateImageTool.handle(mockShofer as Task, partialBlock as ToolUse<"generate_image">, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Should not process anything when partial
			expect(mockAskApproval).not.toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalled()
			expect(mockShofer.say).not.toHaveBeenCalled()
		})

		it("should return early when block is partial even with image parameter", async () => {
			const partialBlock: ToolUse = {
				type: "tool_use",
				name: "generate_image",
				params: {
					prompt: "Upscale this image",
					path: "upscaled-image.png",
					image: "source-image.png",
				},
				nativeArgs: {
					prompt: "Upscale this image",
					path: "upscaled-image.png",
					image: "source-image.png",
				},
				partial: true,
			}

			await generateImageTool.handle(mockShofer as Task, partialBlock as ToolUse<"generate_image">, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Should not process anything when partial
			expect(mockAskApproval).not.toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalled()
			expect(mockShofer.say).not.toHaveBeenCalled()
			expect(fs.readFile).not.toHaveBeenCalled()
		})

		it("should process when block is not partial", async () => {
			const completeBlock: ToolUse = {
				type: "tool_use",
				name: "generate_image",
				params: {
					prompt: "Generate a test image",
					path: "test-image.png",
				},
				nativeArgs: {
					prompt: "Generate a test image",
					path: "test-image.png",
				},
				partial: false,
			}

			// Mock the OpenRouterHandler generateImage method
			const mockGenerateImage = vi.fn().mockResolvedValue({
				success: true,
				imageData: "data:image/png;base64,fakebase64data",
			})

			vi.mocked(OpenRouterHandler).mockImplementation(
				() =>
					({
						generateImage: mockGenerateImage,
					}) as any,
			)

			await generateImageTool.handle(mockShofer as Task, completeBlock as ToolUse<"generate_image">, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Should process the complete block
			expect(mockAskApproval).toHaveBeenCalled()
			expect(mockGenerateImage).toHaveBeenCalled()
			expect(mockPushToolResult).toHaveBeenCalled()
		})

		it("should add cache-busting parameter to image URI", async () => {
			const completeBlock: ToolUse = {
				type: "tool_use",
				name: "generate_image",
				params: {
					prompt: "Generate a test image",
					path: "test-image.png",
				},
				nativeArgs: {
					prompt: "Generate a test image",
					path: "test-image.png",
				},
				partial: false,
			}

			// Mock convertToWebviewUri to return a test URI
			const mockWebviewUri = "https://file+.vscode-resource.vscode-cdn.net/test/workspace/test-image.png"
			mockShofer.providerRef.deref().convertToWebviewUri = vi.fn().mockReturnValue(mockWebviewUri)

			// Mock the OpenRouterHandler generateImage method
			const mockGenerateImage = vi.fn().mockResolvedValue({
				success: true,
				imageData: "data:image/png;base64,fakebase64data",
			})

			vi.mocked(OpenRouterHandler).mockImplementation(
				() =>
					({
						generateImage: mockGenerateImage,
					}) as any,
			)

			await generateImageTool.handle(mockShofer as Task, completeBlock as ToolUse<"generate_image">, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Check that shofer.say was called with image data containing cache-busting parameter
			expect(mockShofer.say).toHaveBeenCalledWith("image", expect.stringMatching(/"imageUri":"[^"]+\?t=\d+"/))

			// Verify the imageUri contains the cache-busting parameter
			const sayCall = mockShofer.say.mock.calls.find((call: any[]) => call[0] === "image")
			if (sayCall) {
				const imageData = JSON.parse(sayCall[1])
				expect(imageData.imageUri).toMatch(/\?t=\d+$/)
				// Handle both Unix and Windows path separators
				const expectedPath =
					process.platform === "win32"
						? "\\test\\workspace\\test-image.png"
						: "/test/workspace/test-image.png"
				expect(imageData.imagePath).toBe(expectedPath)
			}
		})
	})

	describe("missing parameters", () => {
		it("should handle missing prompt parameter", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "generate_image",
				params: {
					path: "test-image.png",
				},
				nativeArgs: {
					path: "test-image.png",
				} as any,
				partial: false,
			}

			await generateImageTool.handle(mockShofer as Task, block as ToolUse<"generate_image">, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockShofer.consecutiveMistakeCount).toBe(1)
			expect(mockShofer.recordToolError).toHaveBeenCalledWith("generate_image")
			expect(mockShofer.sayAndCreateMissingParamError).toHaveBeenCalledWith("generate_image", "prompt")
			expect(mockPushToolResult).toHaveBeenCalledWith("Missing parameter error")
		})

		it("should handle missing path parameter", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "generate_image",
				params: {
					prompt: "Generate a test image",
				},
				nativeArgs: {
					prompt: "Generate a test image",
				} as any,
				partial: false,
			}

			await generateImageTool.handle(mockShofer as Task, block as ToolUse<"generate_image">, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockShofer.consecutiveMistakeCount).toBe(1)
			expect(mockShofer.recordToolError).toHaveBeenCalledWith("generate_image")
			expect(mockShofer.sayAndCreateMissingParamError).toHaveBeenCalledWith("generate_image", "path")
			expect(mockPushToolResult).toHaveBeenCalledWith("Missing parameter error")
		})
	})

	describe("experiment validation", () => {
		it("should error when image generation experiment is disabled", async () => {
			// Disable the experiment
			mockShofer.providerRef.deref().getState.mockResolvedValue({
				experiments: {
					[EXPERIMENT_IDS.IMAGE_GENERATION]: false,
				},
			})

			const block: ToolUse = {
				type: "tool_use",
				name: "generate_image",
				params: {
					prompt: "Generate a test image",
					path: "test-image.png",
				},
				nativeArgs: {
					prompt: "Generate a test image",
					path: "test-image.png",
				},
				partial: false,
			}

			await generateImageTool.handle(mockShofer as Task, block as ToolUse<"generate_image">, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockPushToolResult).toHaveBeenCalledWith(
				formatResponse.toolError(
					"Image generation is an experimental feature that must be enabled in settings. Please enable 'Image Generation' in the Experimental Settings section.",
				),
			)
		})
	})

	describe("input image validation", () => {
		it("should handle non-existent input image", async () => {
			vi.mocked(fileUtils.fileExistsAtPath).mockResolvedValue(false)

			const block: ToolUse = {
				type: "tool_use",
				name: "generate_image",
				params: {
					prompt: "Upscale this image",
					path: "upscaled.png",
					image: "non-existent.png",
				},
				nativeArgs: {
					prompt: "Upscale this image",
					path: "upscaled.png",
					image: "non-existent.png",
				},
				partial: false,
			}

			await generateImageTool.handle(mockShofer as Task, block as ToolUse<"generate_image">, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockShofer.say).toHaveBeenCalledWith("error", expect.stringContaining("Input image not found"))
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Input image not found"))
		})

		it("should handle unsupported image format", async () => {
			const block: ToolUse = {
				type: "tool_use",
				name: "generate_image",
				params: {
					prompt: "Upscale this image",
					path: "upscaled.png",
					image: "test.bmp", // Unsupported format
				},
				nativeArgs: {
					prompt: "Upscale this image",
					path: "upscaled.png",
					image: "test.bmp",
				},
				partial: false,
			}

			await generateImageTool.handle(mockShofer as Task, block as ToolUse<"generate_image">, {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			expect(mockShofer.say).toHaveBeenCalledWith("error", expect.stringContaining("Unsupported image format"))
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Unsupported image format"))
		})
	})
})
