import * as fs from "fs"
import * as path from "path"
import { ensureDirectoryExists } from "../utils/paths.js"
import type { Memento } from "../types.js"

/**
 * Delay between a mutation marking the state dirty and the flush that persists
 * it, in milliseconds.
 *
 * Measured from the FIRST mutation of a batch and never reset by later ones, so
 * a steady stream of updates cannot starve the write: the whole map is written
 * at most once per window regardless of how many keys changed inside it.
 */
const FLUSH_DELAY_MS = 5

/**
 * Process-wide counter making every temp file name unique, so two FileMemento
 * instances pointed at the same path cannot collide on the scratch file.
 */
let tempFileCounter = 0

/**
 * A promise together with the functions that settle it.
 */
interface Deferred<T> {
	promise: Promise<T>
	resolve: (value: T) => void
	reject: (error: unknown) => void
}

/**
 * Create a deferred whose promise already carries a rejection handler.
 *
 * The handler makes an un-awaited failure inert (no `unhandledRejection`) while
 * leaving the promise itself rejectable — a caller that DOES await `update()`
 * still sees the error. Callers of `update()`/`clear()` are free to ignore the
 * returned promise, so both properties are needed at once.
 *
 * @returns A deferred that is safe to hand out un-awaited
 */
function createPreHandledDeferred(): Deferred<void> {
	let resolve!: () => void
	let reject!: (error: unknown) => void
	const promise = new Promise<void>((res, rej) => {
		resolve = res
		reject = rej
	})
	promise.catch(() => {})
	return { promise, resolve, reject }
}

/**
 * File-based implementation of VSCode's Memento interface
 *
 * Provides persistent key-value storage backed by a JSON file. Reads are served
 * from memory; writes are coalesced and flushed asynchronously.
 *
 * ## Write model
 *
 * `update()` mutates the in-memory map, marks the state dirty and schedules a
 * flush, returning a promise that resolves only once the value is DURABLE — the
 * promise it hands back is the promise of the flush that carries the mutation,
 * so awaiting it means the bytes have landed, matching VSCode's "resolves when
 * the update is complete" contract.
 *
 * Every mutation made before a flush starts shares that one flush, so N sets in
 * a tick cost ONE serialize-and-write of the whole map rather than N. Flushes
 * never overlap: a mutation arriving while a write is in flight is picked up by
 * a follow-up flush scheduled when that write lands.
 *
 * Each flush writes to a temp file in the same directory and renames it over
 * the state file, so a reader never observes a partial JSON document and a
 * crash mid-write cannot truncate the state.
 *
 * ## Crash semantics
 *
 * The window between a mutation and its flush is non-zero (up to
 * `FLUSH_DELAY_MS`, plus the duration of any write already in flight), so a
 * hard kill can lose the last updates — which a synchronous write could not.
 * That is the deliberate trade for keeping a full JSON re-serialize plus an
 * fsync off the host's single event loop on every key set; on a network-backed
 * volume each such write measured ~36 ms of blocked loop. Nothing is ever
 * observed half-written thanks to the atomic rename, and a caller that needs a
 * durability barrier has two: await the promise `update()` returns, or call
 * `flush()`.
 *
 * ## Error posture
 *
 * A failed flush rejects the promises awaiting it (and is warned about, for the
 * fire-and-forget callers) rather than being swallowed. The object stays usable
 * and the in-memory map keeps the failed values, so the next mutation rewrites
 * the whole map and a transient failure self-heals. Load failures still fall
 * back to empty state, as an unreadable file is indistinguishable from a first
 * run.
 *
 * @example
 * ```typescript
 * const memento = new FileMemento('/path/to/state.json')
 *
 * // Store a value (resolves once it is on disk)
 * await memento.update('lastOpenFile', '/path/to/file.txt')
 *
 * // Retrieve a value
 * const file = memento.get<string>('lastOpenFile')
 *
 * // With default value
 * const count = memento.get<number>('count', 0)
 * ```
 */
export class FileMemento implements Memento {
	private data: Record<string, unknown> = {}
	private filePath: string

	/**
	 * Settles when the next flush to land has persisted every mutation made so
	 * far; `undefined` when there is nothing waiting to be written.
	 */
	private nextFlush: Deferred<void> | undefined

	/**
	 * Handle of the armed coalescing timer, set only while a flush is scheduled
	 * but has not yet started.
	 */
	private flushTimer: ReturnType<typeof setTimeout> | undefined

	/**
	 * The write currently in flight. Never rejects — a failure travels on the
	 * deferred the write was settling, not on this promise.
	 */
	private writeInFlight: Promise<void> | undefined

	/**
	 * Create a new FileMemento
	 *
	 * @param filePath - Path to the JSON file for persistence
	 */
	constructor(filePath: string) {
		this.filePath = filePath
		this.loadFromFile()
	}

	/**
	 * Load data from the JSON file
	 */
	private loadFromFile(): void {
		try {
			if (fs.existsSync(this.filePath)) {
				const content = fs.readFileSync(this.filePath, "utf-8")
				this.data = JSON.parse(content)
			}
		} catch (error) {
			console.warn(`Failed to load state from ${this.filePath}:`, error)
			this.data = {}
		}
	}

	/**
	 * Mark the state dirty and make sure a flush is coming
	 *
	 * @returns A promise that resolves when the mutations made so far are durable
	 */
	private scheduleFlush(): Promise<void> {
		if (this.nextFlush === undefined) {
			this.nextFlush = createPreHandledDeferred()
		}
		this.armFlushTimer()
		return this.nextFlush.promise
	}

	/**
	 * Arm the coalescing timer, unless one is already armed or a write is in
	 * flight (in which case the flush is re-armed when that write lands)
	 */
	private armFlushTimer(): void {
		if (this.flushTimer !== undefined || this.writeInFlight !== undefined) {
			return
		}
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined
			void this.runFlush()
		}, FLUSH_DELAY_MS)
	}

	/**
	 * Start a flush now: snapshot the map and write it, settling the deferred
	 * that promised those mutations
	 *
	 * The snapshot is taken synchronously so the deferred covers exactly the
	 * mutations made before this call — anything arriving during the write
	 * belongs to the next one.
	 *
	 * @returns A promise that resolves when the write has finished, successfully
	 * or not
	 */
	private runFlush(): Promise<void> {
		if (this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer)
			this.flushTimer = undefined
		}

		const deferred = this.nextFlush
		if (deferred === undefined) {
			return this.writeInFlight ?? Promise.resolve()
		}
		this.nextFlush = undefined

		const snapshot = JSON.stringify(this.data, null, 2)
		const done = this.writeAtomically(snapshot)
			.then(
				() => deferred.resolve(),
				(error: unknown) => {
					console.warn(`Failed to save state to ${this.filePath}:`, error)
					deferred.reject(error)
				},
			)
			.finally(() => {
				this.writeInFlight = undefined
				if (this.nextFlush !== undefined) {
					this.armFlushTimer()
				}
			})

		this.writeInFlight = done
		return done
	}

	/**
	 * Write the serialized state through a temp file renamed into place
	 *
	 * The temp file is a sibling of the state file so the rename stays within one
	 * filesystem and is therefore atomic. A failed write takes its temp file with
	 * it rather than leaving scratch behind.
	 *
	 * @param contents - The serialized state to persist
	 */
	private async writeAtomically(contents: string): Promise<void> {
		const dir = path.dirname(this.filePath)
		ensureDirectoryExists(dir)

		const tempPath = `${this.filePath}.${process.pid}.${++tempFileCounter}.tmp`
		try {
			await fs.promises.writeFile(tempPath, contents, "utf-8")
			await fs.promises.rename(tempPath, this.filePath)
		} catch (error) {
			await fs.promises.rm(tempPath, { force: true }).catch(() => {})
			throw error
		}
	}

	/**
	 * Get a value from storage
	 *
	 * @param key - The key to retrieve
	 * @param defaultValue - Optional default value if key doesn't exist
	 * @returns The stored value or default value
	 */
	get<T>(key: string): T | undefined
	get<T>(key: string, defaultValue: T): T
	get<T>(key: string, defaultValue?: T): T | undefined {
		const value = this.data[key]
		return value !== undefined && value !== null ? (value as T) : defaultValue
	}

	/**
	 * Update a value in storage
	 *
	 * @param key - The key to update
	 * @param value - The value to store (undefined to delete)
	 * @returns A promise that resolves when the update is durable, and rejects if
	 * the flush carrying it failed
	 */
	update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			delete this.data[key]
		} else {
			this.data[key] = value
		}
		return this.scheduleFlush()
	}

	/**
	 * Get all keys in storage
	 *
	 * @returns An array of all keys
	 */
	keys(): readonly string[] {
		return Object.keys(this.data)
	}

	/**
	 * Clear all data from storage
	 *
	 * @returns A promise that resolves when the empty state is durable
	 */
	clear(): Promise<void> {
		this.data = {}
		return this.scheduleFlush()
	}

	/**
	 * Wait for the state to be durable, starting a scheduled flush immediately
	 * rather than waiting out its window
	 *
	 * Loops because a mutation can arrive while an earlier write is in flight;
	 * it returns only once nothing is pending. Rejects with the failure of the
	 * flush it was waiting on.
	 */
	async flush(): Promise<void> {
		for (;;) {
			const inFlight = this.writeInFlight
			if (inFlight !== undefined) {
				await inFlight
				continue
			}

			const deferred = this.nextFlush
			if (deferred === undefined) {
				return
			}

			void this.runFlush()
			await deferred.promise
		}
	}
}
