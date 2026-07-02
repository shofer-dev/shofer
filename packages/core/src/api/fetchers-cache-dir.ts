import * as os from "os"
import * as path from "path"
import * as fs from "fs"

/**
 * Provider that resolves the directory where the model/model-endpoint fetchers
 * persist their on-disk caches.
 *
 * The VS Code extension registers a host-backed provider at activation time
 * (rooting the cache under the extension's global storage), while headless
 * callers fall back to the built-in default (see {@link DEFAULT_CACHE_DIR}).
 */
export interface ModelsCacheDirProvider {
	/** Async resolver — may create the directory as a side effect. */
	getDir: () => Promise<string>
	/**
	 * Synchronous resolver for cold-start / sync disk-cache reads. Must not
	 * throw; return a best-effort path.
	 */
	getDirSync: () => string
}

/**
 * Headless default: a real, writable directory under the OS temp dir. Model
 * fetching must work with no extension host registered, so this never throws —
 * it lazily `mkdir -p`s the directory on the async path and returns the path.
 */
const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), "shofer-model-cache")

const defaultProvider: ModelsCacheDirProvider = {
	getDir: async () => {
		await fs.promises.mkdir(DEFAULT_CACHE_DIR, { recursive: true })
		return DEFAULT_CACHE_DIR
	},
	getDirSync: () => {
		try {
			fs.mkdirSync(DEFAULT_CACHE_DIR, { recursive: true })
		} catch {
			// Best-effort: the sync path is used for optional cold-start reads,
			// so a failure to pre-create the directory must not throw here.
		}
		return DEFAULT_CACHE_DIR
	},
}

let provider: ModelsCacheDirProvider = defaultProvider

/**
 * Register the host-backed cache-directory provider.
 *
 * The VS Code extension calls this at activation with a provider rooted under
 * its global storage so the on-disk model cache lands in the same place as
 * before the core carve-out.
 */
export function setModelsCacheDirProvider(next: ModelsCacheDirProvider): void {
	provider = next
}

/** Restore the headless default provider. Primarily for tests. */
export function resetModelsCacheDirProvider(): void {
	provider = defaultProvider
}

/**
 * Resolve the model-cache directory (async). Ensures the directory exists.
 * Falls back to a writable OS-temp default when no host provider is registered.
 */
export function getModelsCacheDir(): Promise<string> {
	return provider.getDir()
}

/**
 * Resolve the model-cache directory (sync) for cold-start disk-cache reads.
 * Never throws; returns a best-effort path.
 */
export function getModelsCacheDirSync(): string {
	return provider.getDirSync()
}
