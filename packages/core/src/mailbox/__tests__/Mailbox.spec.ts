// npx vitest src/mailbox/__tests__/Mailbox.spec.ts

import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"
import { randomUUID } from "crypto"

import {
	MAILBOX_CAPACITY,
	MAILBOX_DIGEST_MAX_ROWS,
	deriveSubject,
	type Envelope,
	type MailboxKind,
} from "@shofer/types"

import { Mailbox, MailboxError, remainingSeconds } from "../Mailbox.js"

/**
 * The mailbox is exercised against a REAL temporary directory rather than a
 * mocked `fs`: persistence is half of its contract (a `wake` to a task with no
 * live instance is implemented by writing the file first), and a mocked writer
 * would let a round-trip pass without anything ever reaching a disk.
 */
describe("Mailbox", () => {
	const TASK_ID = "task-under-test"

	let storageRoot: string
	/**
	 * The tests' notion of "now". It tracks the REAL clock rather than being a
	 * fixed epoch, because `load()` sweeps at the real current time — a box
	 * persisted with deadlines in a frozen past would come back empty and every
	 * round-trip assertion would pass vacuously.
	 */
	let NOW: number

	beforeEach(async () => {
		NOW = Date.now()
		storageRoot = path.join(os.tmpdir(), `shofer-mailbox-${randomUUID()}`)
		await fs.mkdir(storageRoot, { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(storageRoot, { recursive: true, force: true })
	})

	const makeBox = () => new Mailbox(TASK_ID, storageRoot)

	const envelope = (overrides: Partial<Envelope> & { kind?: MailboxKind } = {}): Envelope =>
		({
			id: overrides.id ?? randomUUID(),
			from: "task-sender",
			to: TASK_ID,
			kind: "notification",
			subject: "a subject",
			body: "a body",
			deadline: NOW + 60_000,
			wake: false,
			sent_at: NOW,
			plane: "local",
			...overrides,
		}) as Envelope

	describe("deliver", () => {
		it("appends, persists and emits", async () => {
			const box = makeBox()
			const delivered: Envelope[] = []
			box.on("delivered", (env) => delivered.push(env))

			const env = envelope({ subject: "hello" })
			await box.deliver(env, NOW)

			expect(box.pending(NOW)).toHaveLength(1)
			expect(delivered).toHaveLength(1)
			expect(delivered[0]!.subject).toBe("hello")

			// Durable, not merely in memory.
			const reloaded = await Mailbox.load(TASK_ID, storageRoot)
			expect(reloaded.pending(NOW).map((e) => e.id)).toEqual([env.id])
		})

		it("acknowledges a duplicate id without appending it again", async () => {
			const box = makeBox()
			const delivered: Envelope[] = []
			box.on("delivered", (env) => delivered.push(env))

			const env = envelope({ id: "same-id", subject: "first" })
			await box.deliver(env, NOW)
			const second = await box.deliver({ ...env, subject: "retry" }, NOW)

			expect(box.pending(NOW)).toHaveLength(1)
			// The FIRST envelope is what stays and what is returned — a retry must
			// not silently rewrite a message the recipient may already have read.
			expect(second.subject).toBe("first")
			expect(delivered).toHaveLength(1)
		})

		it("refuses an envelope addressed to another task", async () => {
			const box = makeBox()
			await expect(box.deliver(envelope({ to: "somebody-else" }), NOW)).rejects.toMatchObject({
				code: "misaddressed",
			})
			expect(box.pending(NOW)).toHaveLength(0)
		})

		it("refuses a payload that is not an envelope", async () => {
			const box = makeBox()
			await expect(box.deliver({ body: "no id, no deadline" }, NOW)).rejects.toBeInstanceOf(MailboxError)
			// A `reply` with nothing to reply to is equally not an envelope.
			await expect(box.deliver(envelope({ kind: "reply" }), NOW)).rejects.toMatchObject({ code: "invalid" })
		})

		it("refuses a delivery into a full box rather than evicting the oldest", async () => {
			const box = makeBox()
			for (let i = 0; i < MAILBOX_CAPACITY; i++) {
				await box.deliver(envelope({ id: `full-${i}` }), NOW)
			}
			await expect(box.deliver(envelope({ id: "one-too-many" }), NOW)).rejects.toMatchObject({ code: "full" })
			expect(box.size(NOW)).toBe(MAILBOX_CAPACITY)
			expect(box.pending(NOW)[0]!.id).toBe("full-0")
		})

		it("lets an expired envelope's slot be reused", async () => {
			const box = makeBox()
			for (let i = 0; i < MAILBOX_CAPACITY; i++) {
				await box.deliver(envelope({ id: `full-${i}`, deadline: NOW + 1_000 }), NOW)
			}
			// One second later every one of them has lapsed, so the box has room.
			await expect(box.deliver(envelope({ id: "later" }), NOW + 2_000)).resolves.toMatchObject({ id: "later" })
			expect(box.size(NOW + 2_000)).toBe(1)
		})
	})

	describe("sweep", () => {
		it("drops exactly the envelopes whose deadline has passed", async () => {
			const box = makeBox()
			await box.deliver(envelope({ id: "short", deadline: NOW + 1_000 }), NOW)
			await box.deliver(envelope({ id: "long", deadline: NOW + 600_000 }), NOW)

			expect(box.sweep(NOW + 500).map((e) => e.id)).toEqual([])
			const dropped = box.sweep(NOW + 5_000)

			expect(dropped.map((e) => e.id)).toEqual(["short"])
			expect(box.pending(NOW + 5_000).map((e) => e.id)).toEqual(["long"])
		})

		it("expires on the persisted deadline across a reload, not on a fresh lease", async () => {
			const box = makeBox()
			await box.deliver(envelope({ id: "short", deadline: NOW + 1_000 }), NOW)

			const reloaded = new Mailbox(TASK_ID, storageRoot)
			await reloaded.load()
			expect(reloaded.pending(NOW + 5_000)).toHaveLength(0)
		})
	})

	describe("digest", () => {
		it("renders nothing at all for an empty box", () => {
			expect(makeBox().digest(NOW)).toBeUndefined()
		})

		it("renders one row per pending envelope with the remaining time", async () => {
			const box = makeBox()
			await box.deliver(
				envelope({
					id: "7c1e0000-aaaa",
					from: "task-9f2a",
					kind: "request",
					subject: "Which tables does UserService use?",
					deadline: NOW + 47_000,
				}),
				NOW,
			)
			await box.deliver(
				envelope({
					id: "b0d40000-bbbb",
					from: "tag:resource:vm-12",
					subject: "vm-12 entered Ready",
					plane: "bus",
					deadline: NOW + 480_000,
				}),
				NOW,
			)
			await box.deliver(
				envelope({
					id: "e55a0000-cccc",
					from: "task-1a77",
					kind: "reply",
					in_reply_to: "3d9c0000-dddd",
					subject: "Use the staging DB",
					deadline: NOW + 60_000,
				}),
				NOW,
			)

			const digest = box.digest(NOW, (from) => (from === "task-9f2a" ? "Analyze auth" : undefined))!
			const lines = digest.split("\n")

			expect(lines[0]).toBe(
				"# Mailbox (3 pending — call wait(timeout_sec=0) to read; reply(...) answers a request)",
			)
			expect(lines[1]).toBe(
				'- 7c1e0000… · from task-9f2a ("Analyze auth") · request · "Which tables does UserService use?" · 47s left',
			)
			expect(lines[2]).toBe(
				'- b0d40000… · from tag:resource:vm-12 · notification · "vm-12 entered Ready" · 8m left',
			)
			expect(lines[3]).toBe('- e55a0000… · from task-1a77 · reply to 3d9c0000… · "Use the staging DB" · 1m left')
		})

		it("marks a request the agent has already read as awaiting its reply", async () => {
			const box = makeBox()
			await box.deliver(envelope({ id: "req-1", kind: "request", subject: "well?" }), NOW)

			expect(box.digest(NOW)).not.toContain("awaiting your reply")
			await box.drain(NOW)
			expect(box.digest(NOW)).toContain("awaiting your reply")
		})

		it("caps the rows and counts the rest", async () => {
			const box = makeBox()
			const total = MAILBOX_DIGEST_MAX_ROWS + 5
			for (let i = 0; i < total; i++) {
				await box.deliver(envelope({ id: `d-${i}` }), NOW)
			}

			const lines = box.digest(NOW)!.split("\n")
			// header + capped rows + the "+K more" line
			expect(lines).toHaveLength(1 + MAILBOX_DIGEST_MAX_ROWS + 1)
			expect(lines.at(-1)).toBe("- +5 more — call wait(timeout_sec=0)")
		})

		it("removes nothing", async () => {
			const box = makeBox()
			await box.deliver(envelope({ id: "n-1" }), NOW)
			box.digest(NOW)
			box.digest(NOW)
			expect(box.pending(NOW)).toHaveLength(1)
		})
	})

	describe("drain", () => {
		it("returns everything with a derived remaining_sec", async () => {
			const box = makeBox()
			await box.deliver(envelope({ id: "n-1", deadline: NOW + 90_000 }), NOW)

			const read = await box.drain(NOW + 30_000)
			expect(read).toHaveLength(1)
			expect(read[0]!.remaining_sec).toBe(60)
			expect(read[0]!.read_at).toBe(NOW + 30_000)
		})

		it("consumes notifications and replies but keeps requests until they are answered", async () => {
			const box = makeBox()
			await box.deliver(envelope({ id: "n-1" }), NOW)
			await box.deliver(envelope({ id: "r-1", kind: "request" }), NOW)
			await box.deliver(envelope({ id: "y-1", kind: "reply", in_reply_to: "x" }), NOW)

			const read = await box.drain(NOW)
			expect(read.map((e) => e.id).sort()).toEqual(["n-1", "r-1", "y-1"])
			expect(box.pending(NOW).map((e) => e.id)).toEqual(["r-1"])

			// A second drain returns the still-unanswered request and nothing else.
			expect((await box.drain(NOW)).map((e) => e.id)).toEqual(["r-1"])

			// And the consumption is durable, not just in memory.
			const reloaded = await Mailbox.load(TASK_ID, storageRoot)
			expect(reloaded.pending(NOW).map((e) => e.id)).toEqual(["r-1"])
		})

		it("returns an empty array for an empty box", async () => {
			expect(await makeBox().drain(NOW)).toEqual([])
		})
	})

	describe("resolveRequest", () => {
		it("removes the request and returns it so the reply can be addressed", async () => {
			const box = makeBox()
			await box.deliver(envelope({ id: "r-1", from: "task-asker", kind: "request" }), NOW)

			const resolved = await box.resolveRequest("r-1", NOW)
			expect(resolved.from).toBe("task-asker")
			expect(box.pending(NOW)).toHaveLength(0)

			const reloaded = await Mailbox.load(TASK_ID, storageRoot)
			expect(reloaded.pending(NOW)).toHaveLength(0)
		})

		it("rejects an unknown id rather than dropping the reply", async () => {
			await expect(makeBox().resolveRequest("nope", NOW)).rejects.toMatchObject({ code: "unknown-request" })
		})

		it("rejects a notification's id — only a request can be replied to", async () => {
			const box = makeBox()
			await box.deliver(envelope({ id: "n-1" }), NOW)
			await expect(box.resolveRequest("n-1", NOW)).rejects.toMatchObject({ code: "unknown-request" })
		})

		it("distinguishes an EXPIRED request from an unknown one", async () => {
			const box = makeBox()
			await box.deliver(envelope({ id: "r-1", kind: "request", deadline: NOW + 1_000 }), NOW)
			await expect(box.resolveRequest("r-1", NOW + 5_000)).rejects.toMatchObject({ code: "expired-request" })
		})
	})

	describe("persistence", () => {
		it("round-trips the whole box", async () => {
			const box = makeBox()
			await box.deliver(envelope({ id: "n-1", subject: "first" }), NOW)
			await box.deliver(envelope({ id: "r-1", kind: "request", subject: "second" }), NOW)

			const reloaded = await Mailbox.load(TASK_ID, storageRoot)
			expect(reloaded.pending(NOW).map((e) => [e.id, e.subject, e.kind])).toEqual([
				["n-1", "first", "notification"],
				["r-1", "second", "request"],
			])
		})

		it("does not let an in-flight load overwrite a delivery that raced it", async () => {
			// `Task` constructs its mailbox and kicks the load off WITHOUT awaiting
			// it, so this window is real: a wake delivered into a just-rehydrated
			// task arrives while the file is still being read.
			const seeded = makeBox()
			await seeded.deliver(envelope({ id: "on-disk" }), NOW)

			const box = new Mailbox(TASK_ID, storageRoot)
			const loading = box.load()
			const delivering = box.deliver(envelope({ id: "raced-in" }), NOW)
			await Promise.all([loading, delivering])

			expect(
				box
					.pending(NOW)
					.map((e) => e.id)
					.sort(),
			).toEqual(["on-disk", "raced-in"])
		})

		it("fails closed on an unreadable file instead of refusing to start", async () => {
			const box = makeBox()
			await box.deliver(envelope({ id: "n-1" }), NOW)

			const file = path.join(storageRoot, "tasks", TASK_ID, "mailbox.json")
			await fs.writeFile(file, "{ not json", "utf8")

			const reloaded = await Mailbox.load(TASK_ID, storageRoot)
			expect(reloaded.pending(NOW)).toEqual([])
		})

		it("discards a snapshot written for a different task", async () => {
			const other = new Mailbox("some-other-task", storageRoot)
			await other.deliver(envelope({ id: "n-1", to: "some-other-task" }), NOW)

			// Same bytes, wrong directory: the taskId inside the snapshot is what
			// decides, so a misplaced file is dropped rather than adopted.
			const src = path.join(storageRoot, "tasks", "some-other-task", "mailbox.json")
			const dstDir = path.join(storageRoot, "tasks", TASK_ID)
			await fs.mkdir(dstDir, { recursive: true })
			await fs.copyFile(src, path.join(dstDir, "mailbox.json"))

			const reloaded = await Mailbox.load(TASK_ID, storageRoot)
			expect(reloaded.pending(NOW)).toEqual([])
		})
	})

	it("derives a subject from the body when the sender supplied none", () => {
		expect(deriveSubject("  hello\n\n   world  ")).toBe("hello world")
		expect(deriveSubject("x".repeat(200))).toHaveLength(80)
		expect(deriveSubject("x".repeat(200)).endsWith("…")).toBe(true)
	})

	it("derives remaining_sec from the absolute deadline and never goes negative", () => {
		const env = envelope({ deadline: NOW + 10_000 })
		expect(remainingSeconds(env, NOW)).toBe(10)
		expect(remainingSeconds(env, NOW + 99_000)).toBe(0)
	})
})
