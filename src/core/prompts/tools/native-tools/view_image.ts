import type OpenAI from "openai"

const VIEW_IMAGE_DESCRIPTION = `Request to view an image file. This tool reads an image file and returns it for visual analysis. Supports common image formats (PNG, JPG, JPEG, GIF, BMP, SVG, WEBP).

Parameters:
- path: (required) Path to the image file (also accepts filePath as alias), relative to the workspace

Example: View an image
{ "path": "assets/screenshot.png" }`

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
				path: {
					type: "string",
					description: FILE_PATH_PARAMETER_DESCRIPTION,
				},
				filePath: {
					type: "string",
					description: "Alias for 'path'. " + FILE_PATH_PARAMETER_DESCRIPTION,
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
