import type { HostBridge, HostConfig, HostEnv, HostFileSystem, Notifier, NotifyChoiceOptions } from "./host.js"

/**
 * In-memory / no-op host implementations (§9) for the CLI, tests, and as a
 * reference for what a host adapter must provide. No `vscode`, no real disk.
 */

/** A `Notifier` that records messages instead of showing UI. */
export class RecordingNotifier implements Notifier {
	readonly messages: Array<{ level: "info" | "warn" | "error"; message: string }> = []
	/** Choice returned by `showChoice` (default: dismissed). Set in tests to simulate a click. */
	choiceResponse: string | undefined = undefined
	info(message: string): void {
		this.messages.push({ level: "info", message })
	}
	warn(message: string): void {
		this.messages.push({ level: "warn", message })
	}
	error(message: string): void {
		this.messages.push({ level: "error", message })
	}
	async showChoice(message: string, _options: string[], opts?: NotifyChoiceOptions): Promise<string | undefined> {
		this.messages.push({
			level: opts?.severity === "error" ? "error" : opts?.severity === "warn" ? "warn" : "info",
			message,
		})
		return this.choiceResponse
	}
}

/** An in-memory `HostFileSystem` backed by a Map (paths are used verbatim as keys). */
export class InMemoryFileSystem implements HostFileSystem {
	private readonly files = new Map<string, string>()
	private readonly dirs = new Set<string>()

	async readFile(path: string): Promise<string> {
		const content = this.files.get(path)
		if (content === undefined) throw new Error(`ENOENT: ${path}`)
		return content
	}
	async writeFile(path: string, content: string): Promise<void> {
		this.files.set(path, content)
	}
	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.dirs.has(path)
	}
	async mkdir(path: string): Promise<void> {
		this.dirs.add(path)
	}
	async delete(path: string): Promise<void> {
		this.files.delete(path)
		this.dirs.delete(path)
	}
}

/** An in-memory `HostConfig` (returns the provided default unless a value was `set`). */
export class InMemoryConfig implements HostConfig {
	private readonly values = new Map<string, unknown>()
	set(section: string, key: string, value: unknown): void {
		this.values.set(`${section}.${key}`, value)
	}
	get<T>(section: string, key: string, defaultValue: T): T {
		const v = this.values.get(`${section}.${key}`)
		return v === undefined ? defaultValue : (v as T)
	}
}

/** A default in-memory `HostEnv` (English, no app root). */
export const inMemoryEnv: HostEnv = { language: "en", appRoot: "" }

/** Build an entirely in-memory `HostBridge` (CLI/test default). */
export function createInMemoryHost(): HostBridge {
	return {
		notifier: new RecordingNotifier(),
		fs: new InMemoryFileSystem(),
		config: new InMemoryConfig(),
		env: inMemoryEnv,
	}
}
