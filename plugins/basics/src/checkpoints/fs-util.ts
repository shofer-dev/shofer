import fs from "fs/promises"

/**
 * Whether `filePath` exists. The plugin carries its own copy rather than importing
 * `@shofer/core`'s: a plugin is a self-contained package loaded at runtime, and
 * reaching into core internals is exactly what the plugin boundary exists to prevent.
 */
export async function fileExistsAtPath(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath)
		return true
	} catch {
		return false
	}
}
