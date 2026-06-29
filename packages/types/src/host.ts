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

/** Options for a choice dialog (maps to `vscode.MessageOptions` + severity). */
export interface NotifyChoiceOptions {
	/** Which `vscode.window.show*Message` variant backs the dialog. Default `info`. */
	severity?: "info" | "warn" | "error"
	/** Show as a blocking modal dialog. */
	modal?: boolean
	/** Secondary detail text (modal only, in VS Code). */
	detail?: string
}

/** User-facing notifications (maps to `vscode.window.show*Message`). */
export interface Notifier {
	info(message: string): void
	warn(message: string): void
	error(message: string): void
	/**
	 * Show a message with action buttons and resolve to the chosen label, or
	 * `undefined` if dismissed (maps to `vscode.window.show*Message(msg, opts,
	 * ...items)`). Covers the choice-dialog call sites that need a return value;
	 * `opts.severity` selects the info/warning/error variant.
	 */
	showChoice(message: string, options: string[], opts?: NotifyChoiceOptions): Promise<string | undefined>
}

/** Configuration reads the core needs (maps to `vscode.workspace.getConfiguration`). */
export interface HostConfig {
	/**
	 * Read a config value. `section` is the configuration namespace (e.g. the
	 * extension id), `key` the setting within it; returns `defaultValue` when unset.
	 * Maps to `vscode.workspace.getConfiguration(section).get(key, defaultValue)`.
	 */
	get<T>(section: string, key: string, defaultValue: T): T
}

/** Host environment facts the core needs (maps to `vscode.env`). */
export interface HostEnv {
	/** UI display language / locale (maps to `vscode.env.language`, e.g. "en"). */
	readonly language: string
	/** Application install root, used to locate bundled binaries (maps to `vscode.env.appRoot`). */
	readonly appRoot: string
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
	readonly config: HostConfig
	readonly env: HostEnv
}
