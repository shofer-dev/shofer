import * as fsp from "fs/promises"
import * as os from "os"
import * as path from "path"

import { createInMemoryHost, setHost } from "@shofer/types"

import { FileContextTracker } from "../FileContextTracker.js"

/**
 * `FileContextTracker` is the task's record of which files entered its context
 * and how. It is deliberately a LEDGER rather than a store: entries are appended
 * and the previous one for a path is marked `stale`, so the history of a file in
 * one task is recoverable rather than overwritten.
 *
 * The property that matters operationally is the WATCHER's discrimination. A
 * write Shofer itself made and a write the USER made look identical to a file
 * watcher, so an edit by the agent arms a one-shot suppression
 * (`markFileAsEditedByRoo`) that the next change event consumes. Without it every
 * agent edit would be reported back to the agent as a user edit — an endless
 * "the file changed under you" loop.
 */

let storage: string
let tracker: FileContextTracker
/** Change handlers the fake host watcher registered, keyed by watched file. */
let changeHandlers: Map<string, Array<() => void>>

function installWatcherHost() {
	changeHandlers = new Map()
	const bridge = createInMemoryHost()
	setHost({
		...bridge,
		watcher: {
			watch: (dir: string, pattern: string) => {
				const key = path.join(dir, pattern)
				return {
					onChange: (handler: () => void) => {
						changeHandlers.set(key, [...(changeHandlers.get(key) ?? []), handler])
						return { dispose: vi.fn() }
					},
					onCreate: () => ({ dispose: vi.fn() }),
					onDelete: () => ({ dispose: vi.fn() }),
					dispose: vi.fn(),
				}
			},
		},
	} as never)
}

/**
 * Fire the change event for a workspace-relative path and let its handler
 * settle. The handler writes metadata asynchronously without being awaited (a
 * watcher callback has nobody to await it), so a test that returned immediately
 * would race the write against its own cleanup.
 */
async function fireChange(relPath: string) {
	const key = path.join(storage, relPath)
	for (const handler of changeHandlers.get(key) ?? []) handler()
	await new Promise((resolve) => setTimeout(resolve, 10))
}

function makeProvider() {
	return { context: { globalStorageUri: { fsPath: storage } } }
}

beforeEach(async () => {
	storage = await fsp.mkdtemp(path.join(os.tmpdir(), "shofer-file-context-"))
	installWatcherHost()
	// The tracker resolves watched paths against its cwd; point it at the same
	// temp dir the metadata lives under so both halves line up.
	tracker = new FileContextTracker(makeProvider() as never, "task-1", storage)
})

afterEach(async () => {
	tracker.dispose()
	await fsp.rm(storage, { recursive: true, force: true, maxRetries: 3 })
})

/** The persisted ledger for this task. */
async function ledger(): Promise<Array<Record<string, unknown>>> {
	const metadata = await tracker.getTaskMetadata("task-1")
	return metadata.files_in_context as never
}

describe("the ledger", () => {
	it("starts empty for a task that has touched nothing", async () => {
		expect(await ledger()).toEqual([])
		expect(await tracker.getTouchedFilePaths()).toEqual([])
	})

	it("records a read with a read date and no edit date", async () => {
		await tracker.trackFileContext("src/a.ts", "read_tool")

		const [entry] = await ledger()
		expect(entry).toMatchObject({ path: "src/a.ts", record_state: "active", record_source: "read_tool" })
		expect(entry!.shofer_read_date).toBeTypeOf("number")
		expect(entry!.shofer_edit_date).toBeNull()
	})

	it("records an agent edit with BOTH a read and an edit date", async () => {
		await tracker.trackFileContext("src/a.ts", "shofer_edited")

		const [entry] = await ledger()
		expect(entry!.shofer_read_date).toBeTypeOf("number")
		expect(entry!.shofer_edit_date).toBeTypeOf("number")
	})

	it("APPENDS and marks the previous entry stale rather than overwriting it", async () => {
		await tracker.trackFileContext("src/a.ts", "read_tool")
		await tracker.trackFileContext("src/a.ts", "shofer_edited")

		const entries = await ledger()
		expect(entries).toHaveLength(2)
		expect(entries[0]!.record_state).toBe("stale")
		expect(entries[1]!.record_state).toBe("active")
	})

	it("carries earlier dates forward onto the new entry", async () => {
		await tracker.trackFileContext("src/a.ts", "read_tool")
		const firstRead = (await ledger())[0]!.shofer_read_date
		await tracker.trackFileContext("src/a.ts", "user_edited")

		const latest = (await ledger()).at(-1)!
		// The user edit did not erase the fact that Shofer had read it.
		expect(latest.shofer_read_date).toBe(firstRead)
		expect(latest.user_edit_date).toBeTypeOf("number")
	})

	it("lists every touched path once, sorted, whatever the source", async () => {
		await tracker.trackFileContext("src/b.ts", "file_mentioned")
		await tracker.trackFileContext("src/a.ts", "read_tool")
		await tracker.trackFileContext("src/a.ts", "shofer_edited")

		// Sorted and de-duplicated, which is what keeps the system-prompt cache
		// key deterministic.
		expect(await tracker.getTouchedFilePaths()).toEqual(["src/a.ts", "src/b.ts"])
	})
})

describe("querying the ledger", () => {
	it("returns files READ by Shofer, most recent first, de-duplicated", async () => {
		await tracker.trackFileContext("src/old.ts", "read_tool")
		await new Promise((r) => setTimeout(r, 2))
		await tracker.trackFileContext("src/new.ts", "file_mentioned")
		await tracker.trackFileContext("src/edited.ts", "shofer_edited")

		const read = await tracker.getFilesReadByRoo()

		expect(read).toEqual(["src/new.ts", "src/old.ts"])
		// An edit is not a read for this purpose.
		expect(read).not.toContain("src/edited.ts")
	})

	it("filters reads by a timestamp", async () => {
		await tracker.trackFileContext("src/before.ts", "read_tool")
		await new Promise((r) => setTimeout(r, 5))
		const cutoff = Date.now()
		await new Promise((r) => setTimeout(r, 5))
		await tracker.trackFileContext("src/after.ts", "read_tool")

		expect(await tracker.getFilesReadByRoo(cutoff)).toEqual(["src/after.ts"])
	})

	it("returns files EDITED by Shofer, most recent first", async () => {
		await tracker.trackFileContext("src/first.ts", "shofer_edited")
		await new Promise((r) => setTimeout(r, 2))
		await tracker.trackFileContext("src/second.ts", "shofer_edited")
		await tracker.trackFileContext("src/read-only.ts", "read_tool")

		const edited = await tracker.getFilesEditedByRoo()

		expect(edited).toEqual(["src/second.ts", "src/first.ts"])
	})

	it("filters edits by a timestamp", async () => {
		await tracker.trackFileContext("src/before.ts", "shofer_edited")
		await new Promise((r) => setTimeout(r, 5))
		const cutoff = Date.now()
		await new Promise((r) => setTimeout(r, 5))
		await tracker.trackFileContext("src/after.ts", "shofer_edited")

		expect(await tracker.getFilesEditedByRoo(cutoff)).toEqual(["src/after.ts"])
	})

	it("returns nothing when the metadata cannot be read", async () => {
		const orphan = new FileContextTracker({ context: {} } as never, "task-1", storage)

		expect(await orphan.getFilesReadByRoo()).toEqual([])
		expect(await orphan.getFilesEditedByRoo()).toEqual([])
		expect(await orphan.getTouchedFilePaths()).toEqual([])
	})

	it("recovers an empty ledger from a corrupt metadata file", async () => {
		await tracker.trackFileContext("src/a.ts", "read_tool")
		const metadataPath = path.join(storage, "tasks", "task-1", "task_metadata.json")
		await fsp.writeFile(metadataPath, "{ not json", "utf8")

		expect(await tracker.getTaskMetadata("task-1")).toEqual({ files_in_context: [] })
	})
})

describe("the watcher's discrimination", () => {
	it("reports a USER edit back to the agent", async () => {
		await tracker.trackFileContext("src/a.ts", "read_tool")
		tracker.getAndClearRecentlyModifiedFiles()

		await fireChange("src/a.ts")

		expect(tracker.getAndClearRecentlyModifiedFiles()).toEqual(["src/a.ts"])
	})

	it("SWALLOWS the change event an agent edit caused, exactly once", async () => {
		await tracker.trackFileContext("src/a.ts", "shofer_edited")
		tracker.getAndClearRecentlyModifiedFiles()

		// The write the agent just made.
		await fireChange("src/a.ts")
		expect(tracker.getAndClearRecentlyModifiedFiles()).toEqual([])

		// The NEXT change is the user's, and is reported.
		await fireChange("src/a.ts")
		expect(tracker.getAndClearRecentlyModifiedFiles()).toEqual(["src/a.ts"])
	})

	it("watches each file once, however many times it is tracked", async () => {
		await tracker.trackFileContext("src/a.ts", "read_tool")
		await tracker.trackFileContext("src/a.ts", "read_tool")

		expect(changeHandlers.get(path.join(storage, "src/a.ts"))).toHaveLength(1)
	})

	it("clears the recently-modified set when it is read", async () => {
		await tracker.trackFileContext("src/a.ts", "user_edited")

		expect(tracker.getAndClearRecentlyModifiedFiles()).toEqual(["src/a.ts"])
		expect(tracker.getAndClearRecentlyModifiedFiles()).toEqual([])
	})
})

describe("the plugin seam", () => {
	it("hands the pre-edit content to the plugins and never throws into the tool", async () => {
		// Core keeps no baseline of its own: what a baseline is FOR lives in a
		// plugin, so this must be safe to call with none installed.
		await expect(tracker.captureOriginal("src/a.ts", "before")).resolves.toBeUndefined()
		await expect(tracker.captureOriginal("src/new.ts", undefined)).resolves.toBeUndefined()
	})
})

describe("cwd reassignment", () => {
	it("resolves later watches against the NEW working directory", async () => {
		const moved = path.join(storage, "worktree")
		await fsp.mkdir(moved, { recursive: true })
		tracker.reassignCwd(moved)

		await tracker.trackFileContext("src/a.ts", "read_tool")

		expect(changeHandlers.has(path.join(moved, "src/a.ts"))).toBe(true)
	})
})
