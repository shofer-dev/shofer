/**
 * Host boundary (todos/opencode_inspired_work.md §9).
 *
 * The agent core currently reaches directly into the VS Code API. §9 puts
 * everything host-specific behind narrow interfaces so the core can run with
 * **zero `vscode` imports** — in the extension (a VS Code-backed adapter), the
 * CLI (today via `vscode-shim`), or a future headless server.
 *
 * `HostBridge` is the aggregate seam. It starts with the two clearest couplings —
 * user notifications and filesystem — alongside the already-extracted message
 * persistence (`MessagePersistencePort`, §5). Editor selection and diff
 * presentation are added as their call sites are migrated (the XL strangler).
 *
 * In-memory reference implementations live in `host-memory.ts` for the CLI/tests;
 * a VS Code-backed adapter is the extension's implementation.
 */

/** User-facing notifications (maps to `vscode.window.show*Message`). */
export interface Notifier {
	info(message: string): void
	warn(message: string): void
	error(message: string): void
}

/** Minimal filesystem the core needs, independent of `vscode.workspace.fs` or `node:fs`. */
export interface HostFileSystem {
	readFile(path: string): Promise<string>
	writeFile(path: string, content: string): Promise<void>
	exists(path: string): Promise<boolean>
	mkdir(path: string): Promise<void>
	delete(path: string): Promise<void>
}

/** Aggregate host boundary handed to the core. */
export interface HostBridge {
	readonly notifier: Notifier
	readonly fs: HostFileSystem
}
