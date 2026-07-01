/**
 * Global string extensions declaration.
 * This file provides type declarations for String.prototype extensions
 * that are used across the codebase.
 *
 * The actual implementation (and the runtime String.prototype.toPosix
 * assignment) lives in @shofer/core (packages/core/src/path/path.ts).
 *
 * This separate declaration file guarantees the ambient type is visible
 * program-wide across src/ and the webview-ui package (which includes
 * ../src/shared in its tsconfig.json), independent of whether a given file
 * imports anything from @shofer/core.
 * Without this file, the webview-ui compilation would fail when processing
 * files that use the toPosix() method.
 */
declare global {
	interface String {
		/**
		 * Convert a path string to POSIX format (forward slashes).
		 * Extended-Length Paths in Windows (\\?\) are preserved.
		 * @returns The path with backslashes converted to forward slashes
		 */
		toPosix(): string
	}
}

// This export is needed to make this file a module
export {}
