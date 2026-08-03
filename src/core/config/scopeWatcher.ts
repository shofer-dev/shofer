import fs from "node:fs"
import * as path from "node:path"

import { configLog as logger } from "@shofer/core"

import type { ScopeRoots } from "./layeredSettingsLoader"

/**
 * scopeWatcher — notices edits to the layered `.shofer/` configuration files while a
 * host is running. The layering itself (which scopes exist, how they merge) is
 * documented in `docs/settings_overlay.md`; this file is only the live half.
 *
 * WHY THIS EXISTS: the overlay is loaded at `ContextProxy` init and after a
 * write-through, and nowhere else — so a host never sees a change made by *another*
 * host or by hand. That is fine for a single desktop VS Code, and wrong for the shape
 * this platform runs: several Shofer processes (the IDE and N headless pods) sharing one
 * filesystem, with the file layer as the configuration source of truth. Without a
 * watcher, "write the file, the fleet converges" is not true and a pool cannot be
 * provisioned by writing data.
 *
 * Deliberately **not** built on `vscode.workspace.createFileSystemWatcher`:
 *   - two of the three scopes (`SHOFER_GLOBAL_DIR`, `~/.shofer`) are outside the
 *     workspace, which is the case VS Code watching serves worst, and
 *   - the vscode-shim's implementation is an emitter that never fires, so on exactly
 *     the headless hosts this feature exists for it would be a silent no-op.
 * `fs.watch` is available to both hosts and behaves the same in each.
 *
 * **Directories are watched, not files**, because both writers here replace rather than
 * mutate:
 *   - {@link writeScopeSetting} writes a temp file and renames over the target, so the
 *     watched inode is not the one that receives the change; and
 *   - a Kubernetes ConfigMap mount (how the global scope arrives in a pod) updates by
 *     building a new timestamped directory and atomically swapping the `..data` symlink —
 *     the settings entry is itself a symlink whose target changes underneath it.
 * A directory watch sees both as events on the directory; a file watch sees neither.
 */

/** How long to collect events before firing, so one logical write fires once. */
const DEFAULT_DEBOUNCE_MS = 150

/** How often to re-check for a scope root that did not exist when watching began. */
const DEFAULT_RETRY_MS = 30_000

export interface ScopeWatcherOptions {
	/** The scope roots to watch (each the `.shofer/` directory itself). */
	roots: ScopeRoots
	/** Filenames inside a root that are interesting; everything else is ignored. */
	files: readonly string[]
	/**
	 * Fires (debounced) with the set of interesting filenames seen to change. A
	 * ConfigMap swap names no individual file, so the callback may receive the whole
	 * `files` set — treat it as "re-read these", never as a precise diff.
	 */
	onChange: (files: string[]) => void
	debounceMs?: number
	retryMs?: number
}

/**
 * Watch the `.shofer/` directory of each resolved scope for changes to
 * {@link ScopeWatcherOptions.files}.
 *
 * Fail-soft throughout: a root that does not exist, or that the platform refuses to
 * watch (inotify exhaustion, a filesystem without change notification), costs that root
 * its liveness and nothing else — the host keeps the configuration it loaded at start.
 * Roots that do not exist yet are retried on a timer, because `~/.shofer` is commonly
 * materialized after the host starts.
 */
export class ScopeWatcher {
	private readonly files: ReadonlySet<string>
	private readonly onChange: (files: string[]) => void
	private readonly debounceMs: number
	private readonly retryMs: number
	/** Roots being watched, keyed by absolute path (the three scopes may coincide). */
	private readonly watchers = new Map<string, fs.FSWatcher>()
	/** Roots that could not be watched yet, retried by {@link retryTimer}. */
	private readonly pending = new Set<string>()
	private retryTimer?: NodeJS.Timeout
	private debounceTimer?: NodeJS.Timeout
	private pendingFiles = new Set<string>()
	private disposed = false
	/**
	 * False until the constructor's first attach pass finishes. A root attached during
	 * that pass was already read by whoever built this watcher, so it must not fire; a
	 * root attached later appeared after start and its contents are unseen, so it must.
	 */
	private started = false

	constructor(options: ScopeWatcherOptions) {
		this.files = new Set(options.files)
		this.onChange = options.onChange
		this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
		this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS

		const roots = [options.roots.global, options.roots.user, options.roots.project]
		for (const root of roots) {
			if (root) {
				this.pending.add(path.resolve(root))
			}
		}

		this.attachPending()
		this.started = true
		if (this.pending.size > 0) {
			// `unref` so a host that is otherwise done (a CLI one-shot) is not held open by
			// a watcher that exists only in case a directory appears.
			this.retryTimer = setInterval(() => this.attachPending(), this.retryMs)
			this.retryTimer.unref?.()
		}
	}

	/** Try to start watching every root not yet watched; silently skip those still absent. */
	private attachPending(): void {
		if (this.disposed) {
			return
		}
		for (const root of [...this.pending]) {
			if (!fs.existsSync(root)) {
				continue
			}
			try {
				const watcher = fs.watch(root, { persistent: false }, (_event, filename) =>
					this.onRawEvent(typeof filename === "string" ? filename : undefined),
				)
				watcher.on("error", (error) => this.onWatchError(root, error))
				this.watchers.set(root, watcher)
				this.pending.delete(root)
				// A root that appeared after start may already hold the files we care about,
				// and their creation events predate this watch — so reconcile once now.
				if (this.started) {
					this.queue(undefined)
				}
			} catch (error) {
				logger.warn(
					`Scope watcher could not watch ${root}: ${error instanceof Error ? error.message : String(error)}`,
				)
				this.pending.delete(root)
			}
		}

		if (this.pending.size === 0 && this.retryTimer) {
			clearInterval(this.retryTimer)
			this.retryTimer = undefined
		}
	}

	/**
	 * A watch that errors after starting (the directory was removed and recreated, which
	 * is exactly what a ConfigMap remount looks like) is dropped back into the pending
	 * set rather than lost, so the retry timer re-establishes it.
	 */
	private onWatchError(root: string, error: unknown): void {
		logger.warn(`Scope watcher on ${root} failed: ${error instanceof Error ? error.message : String(error)}`)
		this.watchers.get(root)?.close()
		this.watchers.delete(root)
		if (this.disposed) {
			return
		}
		this.pending.add(root)
		if (!this.retryTimer) {
			this.retryTimer = setInterval(() => this.attachPending(), this.retryMs)
			this.retryTimer.unref?.()
		}
	}

	/**
	 * Map one raw filesystem event to the interesting files it may have changed.
	 *
	 * `filename` is unreliable by design here: some platforms omit it, and a ConfigMap
	 * swap reports the internal `..data` entry rather than the settings file whose
	 * content just changed. So anything that is not recognisably an unrelated file is
	 * treated as "re-read everything" — a spurious reload is a cheap file read, while a
	 * missed one leaves a pod running stale configuration indefinitely.
	 */
	private onRawEvent(filename: string | undefined): void {
		if (filename && this.files.has(filename)) {
			this.queue(filename)
			return
		}
		if (!filename || filename.startsWith("..")) {
			this.queue(undefined)
		}
	}

	private queue(file: string | undefined): void {
		if (this.disposed) {
			return
		}
		if (file) {
			this.pendingFiles.add(file)
		} else {
			for (const f of this.files) {
				this.pendingFiles.add(f)
			}
		}

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
		}
		this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs)
		this.debounceTimer.unref?.()
	}

	private flush(): void {
		this.debounceTimer = undefined
		if (this.disposed || this.pendingFiles.size === 0) {
			return
		}
		const files = [...this.pendingFiles]
		this.pendingFiles.clear()
		try {
			this.onChange(files)
		} catch (error) {
			logger.error(`Scope watcher handler failed: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	dispose(): void {
		this.disposed = true
		if (this.retryTimer) {
			clearInterval(this.retryTimer)
			this.retryTimer = undefined
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer)
			this.debounceTimer = undefined
		}
		for (const watcher of this.watchers.values()) {
			watcher.close()
		}
		this.watchers.clear()
		this.pending.clear()
		this.pendingFiles.clear()
	}
}
