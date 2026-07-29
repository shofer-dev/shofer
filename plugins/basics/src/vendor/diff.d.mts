/**
 * Types for the pre-bundled `diff` copy in `diff.mjs` (see `build-ui.mjs` for why it is
 * vendored). Only the two functions this plugin uses are declared; the shapes mirror
 * `@types/diff` for the fields read in `changed-files.ts`.
 */

export interface DiffHunk {
	lines: string[]
}

export interface ParsedPatch {
	hunks?: DiffHunk[]
}

export function createTwoFilesPatch(
	oldFileName: string,
	newFileName: string,
	oldContent: string,
	newContent: string,
	oldHeader?: string,
	newHeader?: string,
	options?: { context?: number },
): string

export function parsePatch(patch: string): ParsedPatch[]
