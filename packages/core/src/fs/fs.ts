import { promises as fs } from "fs"

/**
 * Whether a file or directory exists at `filePath`. A trivial `fs.access` wrapper —
 * portable core modules use this rather than reaching into the front-end's
 * `src/utils/fs` (a package cannot import from `src`).
 */
export async function fileExistsAtPath(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath)
		return true
	} catch {
		return false
	}
}
