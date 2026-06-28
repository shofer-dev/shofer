import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "./defineNativeTool"

const VIEW_IMAGE_DESCRIPTION = `Request to view an image file. This tool reads an image file and returns it for visual analysis. Supports common image formats (PNG, JPG, JPEG, GIF, BMP, SVG, WEBP).

Parameters:
- path: (required) Path to the image file (also accepts filePath as alias), relative to the workspace

Example: View an image
{ "path": "assets/screenshot.png" }`

const FILE_PATH_PARAMETER_DESCRIPTION = `Path to the image file, relative to the workspace`

export default defineNativeTool({
	name: "view_image",
	description: VIEW_IMAGE_DESCRIPTION,
	schema: z.object({
		path: z.string().describe(FILE_PATH_PARAMETER_DESCRIPTION),
		filePath: z
			.string()
			.describe("Alias for 'path'. " + FILE_PATH_PARAMETER_DESCRIPTION)
			.optional(),
	}),
})
