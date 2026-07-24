import fs from "fs/promises"
import * as tar from "tar"

/**
 * scope-archive — the pure filesystem half of "export/import = archive a scope's
 * `.shofer/` tree" (todos/config-cleanup.md Part E5).
 *
 * This module is **host-agnostic** (no `vscode`, no `ContextProxy`): it takes a
 * scope's `.shofer/` directory path and produces / consumes a single gzipped tar
 * archive of its contents. The host-facing wrappers (dialogs, default scope
 * resolution) live in `src/core/config/importExport.ts`.
 *
 * **Secrets are out of the archive by construction.** Provider API keys never
 * live under `.shofer/` — they stay in VS Code `SecretStorage` (a SQLite store
 * outside the scope directory), and `settings.json` references provider profiles
 * by name/id only. Archiving the directory therefore cannot capture any secret
 * material, which is exactly what makes a `.shofer/` bundle safe to hand around.
 * `tar` is the archiver already vendored by `@shofer/core`; the produced archive
 * is a `.tar.gz` (gzipped tar), the repo's available archive format.
 */

/**
 * Archive the **contents** of a scope's `.shofer/` directory into `destPath` as a
 * gzipped tar. Entries are stored relative to the scope directory (top-level
 * names, recursed into), so {@link importScopeArchive} restores them directly
 * into a target scope root regardless of where either lives on disk.
 *
 * @param scopeDir  the scope's `.shofer/` directory (e.g. `~/.shofer`)
 * @param destPath  the archive file to write (created/overwritten)
 */
export async function exportScopeArchive(scopeDir: string, destPath: string): Promise<void> {
	// Top-level entries of the scope dir; each is archived recursively by tar.
	const entries = await fs.readdir(scopeDir)
	await tar.create({ gzip: true, file: destPath, cwd: scopeDir }, entries)
}

/**
 * Restore a scope archive produced by {@link exportScopeArchive} into
 * `scopeDir`, creating it if absent. Existing files with the same relative path
 * are overwritten; files not present in the archive are left untouched.
 *
 * @param archivePath  the `.tar.gz` produced by {@link exportScopeArchive}
 * @param scopeDir     the target scope's `.shofer/` directory to unpack into
 */
export async function importScopeArchive(archivePath: string, scopeDir: string): Promise<void> {
	await fs.mkdir(scopeDir, { recursive: true })
	await tar.extract({ file: archivePath, cwd: scopeDir })
}

/**
 * List the relative entry paths inside a scope archive without extracting it.
 * Primarily a test/inspection affordance (assert an archive carries
 * `settings.json` and no secret material).
 */
export async function listScopeArchiveEntries(archivePath: string): Promise<string[]> {
	const entries: string[] = []
	await tar.list({
		file: archivePath,
		onentry: (entry) => {
			entries.push(entry.path)
		},
	})
	return entries
}
