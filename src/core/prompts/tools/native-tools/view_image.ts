import type OpenAI from "openai"

const VIEW_IMAGE_DESCRIPTION = `Request to view an image file. This tool reads an image file and returns it for visual analysis. Supports common image formats (PNG, JPG, JPEG, GIF, BMP, SVG, WEBP).

Parameters:
- filePath: (required) Path to the image file, relative to the workspace

Example: View an image
{ "filePath": "assets/screenshot.png" }`

const FILE_PATH_PARAMETER_DESCRIPTION = `Path to the image file, relative to the workspace`

export default {
	type: "function",
	function: {
		name: "view_image",
		description: VIEW_IMAGE_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				filePath: {
					type: "string",
					description: FILE_PATH_PARAMETER_DESCRIPTION,
				},
			},
			required: ["filePath"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
