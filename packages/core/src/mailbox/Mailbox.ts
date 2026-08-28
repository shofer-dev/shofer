/**
 * The per-task mailbox.
 *
 * One `Mailbox` belongs to one `Task` (owned exactly like its
 * `MessageQueueService`) and is the single destination for every message that
 * reaches that agent, whatever plane carried it. It holds {@link Envelope}s,
 * enforces their absolute deadlines lazily at read time, persists itself to one
 * JSON file beside the task's history, and emits `delivered` so a task parked
 * waiting for mail can return the instant something arrives.
 *
 * Three invariants shape the implementation:
 *
 * - **Idempotent on `id`.** A duplicate delivery is ACKNOWLEDGED, not appended.
 *   Relays retry; a box that grew a copy per retry would turn an at-least-once
 *   transport into a duplicated conversation.
 * - **Bounded twice.** Deadlines evict by time and {@link MAILBOX_CAPACITY}
 *   evicts by count — but the cap REFUSES the newest delivery rather than
 *   dropping the oldest message, so a full box is a loud error at the sender
 *   instead of silent amnesia at the recipient.
 * - **Read is not the same as removal.** A notification (or a reply) is removed
 *   when it is returned IN FULL by {@link drain}; merely listing it in the
 *   {@link digest} removes nothing. A request survives its own reading and is
 *   removed only when it is replied to or expires — which is what lets the
 *   digest keep saying "awaiting your reply".
 *
 * The mailbox is deliberately NOT the human's conversation: user turns keep
 * flowing through `MessageQueueService`. The two meet at exactly one point, in
 * `Task.deliver`, where a `wake` delivery to a stopped loop is implemented by
 * enqueueing one synthesized user turn.
 */

import { EventEmitter } from "events"
import * as path from "path"
import * as fs from "fs/promises"

import { z } from "zod"

import {
	envelopeSchema,
	MAILBOX_CAPACITY,
	MAILBOX_DIGEST_MAX_ROWS,
	type Envelope,
	type MailboxKind,
} from "@shofer/types"

import { GlobalFileNames } from "../shared/globalFileNames.js"
import { getTaskDirectoryPath } from "../utils/storage.js"
import { safeWriteJson } from "../utils/safeWriteJson.js"
import { taskLog } from "../logging/subsystems.js"

/** Snapshot format version — a mismatch discards the file rather than migrating it. */
const MAILBOX_SNAPSHOT_VERSION = 1

/**
 * The persisted shape. `taskId` is carried so a snapshot that somehow reaches
 * the wrong directory is detected instead of silently adopted.
 */
const mailboxSnapshotSchema = z.object({
	version: z.literal(MAILBOX_SNAPSHOT_VERSION),
	taskId: z.string(),
	envelopes: z.array(envelopeSchema),
})

/** Why a mailbox operation was refused. Callers branch on this, never on the message text. */
export type MailboxErrorCode =
	| "invalid" /** the payload is not an envelope */
	| "misaddressed" /** `to` names a different task */
	| "full" /** the box already holds {@link MAILBOX_CAPACITY} envelopes */
	| "unknown-request" /** no request with that id is in the box */
	| "expired-request" /** a request with that id existed but its deadline has passed */

/** A refused mailbox operation. */
export class MailboxError extends Error {
	constructor(
		readonly code: MailboxErrorCode,
		message: string,
	) {
		super(message)
		this.name = "MailboxError"
	}
}

/** An envelope returned to the agent, with the remaining time computed at read time. */
export interface ReadEnvelope extends Envelope {
	/** `max(0, deadline - now)` in seconds — derived per read, never stored. */
	remaining_sec: number
}

export interface MailboxEvents {
	/** A new envelope was accepted (never fires for a duplicate id). */
	delivered: [envelope: Envelope]
}

/**
 * Resolve a sender address to a human-readable title, when one is known.
 *
 * Supplied by the caller because titles are host state (`TaskManager`), not
 * mailbox state; a mailbox with no resolver renders the raw address, which is
 * still unambiguous.
 */
export type MailboxTitleResolver = (from: string) => string | undefined

/** Abbreviate an id for a digest row — enough to disambiguate, short enough to scan. */
const shortId = (id: string): string => (id.length <= 8 ? id : `${id.slice(0, 8)}…`)

/** Render `max(0, deadline - now)` as a compact human duration (`47s`, `8m`, `2h`). */
function formatRemaining(remainingSec: number): string {
	if (remainingSec < 60) return `${Math.floor(remainingSec)}s`
	if (remainingSec < 3600) return `${Math.floor(remainingSec / 60)}m`
	return `${Math.floor(remainingSec / 3600)}h`
}

export class Mailbox extends EventEmitter<MailboxEvents> {
	private envelopes: Envelope[] = []

	/** Resolved lazily on first persist/load; `undefined` until then. */
	private filePath: string | undefined

	/**
	 * The in-flight hydration, awaited by every mutator.
	 *
	 * `Task` constructs its mailbox synchronously and kicks the load off without
	 * awaiting it, so a delivery can land while the file is still being read —
	 * and hydration REPLACES the contents. Without this gate that delivery would
	 * be silently overwritten by the snapshot that predates it, which is the
	 * exact window a `wake` to a just-rehydrated task lives in.
	 */
	private hydration: Promise<void> = Promise.resolve()

	/**
	 * @param taskId The task this box belongs to. Every accepted envelope's `to` must equal it.
	 * @param globalStoragePath Storage root; the file lands in this task's own directory.
	 */
	constructor(
		readonly taskId: string,
		private readonly globalStoragePath: string,
	) {
		super()
	}

	/**
	 * Construct a mailbox and hydrate it from disk in one step.
	 *
	 * Used where there is no live `Task` yet — the provider persists an envelope
	 * into a dormant task's box BEFORE rehydrating it, so the rehydrated task's
	 * own constructor-time load finds the message already there.
	 */
	static async load(taskId: string, globalStoragePath: string): Promise<Mailbox> {
		const mailbox = new Mailbox(taskId, globalStoragePath)
		await mailbox.load()
		return mailbox
	}

	/** Absolute path of this mailbox's file, creating the task directory if needed. */
	private async resolveFilePath(): Promise<string> {
		if (!this.filePath) {
			const taskDir = await getTaskDirectoryPath(this.globalStoragePath, this.taskId)
			this.filePath = path.join(taskDir, GlobalFileNames.mailbox)
		}
		return this.filePath
	}

	/**
	 * Replace the in-memory contents with what is on disk, dropping anything that
	 * expired while the task was not running.
	 *
	 * Fails CLOSED: a missing, unreadable, corrupt or version-mismatched file
	 * yields an empty box (overwritten on the next mutation) rather than throwing
	 * — a task must still start when its mailbox file is unusable.
	 */
	async load(): Promise<void> {
		this.hydration = this.hydrate()
		return this.hydration
	}

	/**
	 * Await any in-flight hydration, ignoring its failure (which {@link hydrate}
	 * has already turned into an empty box).
	 */
	private async hydrated(): Promise<void> {
		try {
			await this.hydration
		} catch {
			// hydrate() fails closed; nothing to recover here.
		}
	}

	private async hydrate(): Promise<void> {
		let raw: string
		try {
			raw = await fs.readFile(await this.resolveFilePath(), "utf8")
		} catch {
			this.envelopes = []
			return
		}

		try {
			const parsed = mailboxSnapshotSchema.safeParse(JSON.parse(raw))
			if (!parsed.success || parsed.data.taskId !== this.taskId) {
				this.envelopes = []
				return
			}
			this.envelopes = parsed.data.envelopes
			this.sweep()
		} catch (error) {
			taskLog.error(`[Mailbox#${this.taskId}] discarding unreadable mailbox file:`, error)
			this.envelopes = []
		}
	}

	/**
	 * Write the current contents to disk.
	 *
	 * Called by every mutating operation. Read-only operations (`digest`) do not
	 * persist the envelopes their sweep dropped: expiry is deterministic from the
	 * stored deadlines, so {@link load} re-derives exactly the same result, and
	 * making the per-turn digest a disk write would be a cost paid every turn for
	 * nothing.
	 */
	async persist(): Promise<void> {
		const snapshot = {
			version: MAILBOX_SNAPSHOT_VERSION,
			taskId: this.taskId,
			envelopes: this.envelopes,
		}
		try {
			await safeWriteJson(await this.resolveFilePath(), snapshot)
		} catch (error) {
			taskLog.error(`[Mailbox#${this.taskId}] failed to persist mailbox:`, error)
		}
	}

	/**
	 * Accept an envelope.
	 *
	 * Validates the payload, refuses one addressed elsewhere or arriving into a
	 * full box, treats a known `id` as an acknowledged duplicate, then appends,
	 * persists, and emits `delivered`. Resolves only once the envelope is durable,
	 * so a transport that acks on return is telling the truth.
	 *
	 * @throws {MailboxError} `invalid` | `misaddressed` | `full`
	 */
	async deliver(envelope: unknown, now: number = Date.now()): Promise<Envelope> {
		await this.hydrated()

		const parsed = envelopeSchema.safeParse(envelope)
		if (!parsed.success) {
			throw new MailboxError("invalid", `Not a valid envelope: ${parsed.error.issues[0]?.message ?? "unknown"}`)
		}
		const env = parsed.data

		if (env.to !== this.taskId) {
			throw new MailboxError(
				"misaddressed",
				`Envelope ${env.id} is addressed to ${env.to}, not to ${this.taskId}.`,
			)
		}

		// Sweep first: an expired envelope must not hold a slot against a live one.
		this.sweep(now)

		const existing = this.envelopes.find((e) => e.id === env.id)
		if (existing) {
			return existing
		}

		if (this.envelopes.length >= MAILBOX_CAPACITY) {
			throw new MailboxError(
				"full",
				`Mailbox of task ${this.taskId} is full (${MAILBOX_CAPACITY} envelopes); message ${env.id} refused.`,
			)
		}

		this.envelopes.push(env)
		await this.persist()
		this.emit("delivered", env)
		return env
	}

	/**
	 * Drop every envelope whose deadline has passed and return them.
	 *
	 * Called at the start of every read. Purely in-memory — see {@link persist}
	 * for why a sweep does not write.
	 */
	sweep(now: number = Date.now()): Envelope[] {
		const expired = this.envelopes.filter((env) => env.deadline <= now)
		if (expired.length > 0) {
			this.envelopes = this.envelopes.filter((env) => env.deadline > now)
		}
		return expired
	}

	/** Everything still live, oldest first. */
	pending(now: number = Date.now()): Envelope[] {
		this.sweep(now)
		return [...this.envelopes]
	}

	/** How many envelopes are live. */
	size(now: number = Date.now()): number {
		this.sweep(now)
		return this.envelopes.length
	}

	/**
	 * The `# Mailbox` section for `environment_details`, or `undefined` when the
	 * box is empty (the section is then omitted entirely rather than rendered as
	 * "nothing here", which would cost tokens every turn to say nothing).
	 *
	 * Rendering removes NOTHING: the digest is a listing, and only `drain`
	 * consumes. Rows follow `id · from · kind · subject · remaining`, capped at
	 * {@link MAILBOX_DIGEST_MAX_ROWS} with a trailing count of what was elided.
	 */
	digest(now: number = Date.now(), resolveTitle?: MailboxTitleResolver): string | undefined {
		const pending = this.pending(now)
		if (pending.length === 0) {
			return undefined
		}

		const shown = pending.slice(0, MAILBOX_DIGEST_MAX_ROWS)
		const elided = pending.length - shown.length

		const lines = [
			`# Mailbox (${pending.length} pending — call wait(timeout_sec=0) to read; reply(...) answers a request)`,
			...shown.map((env) => this.digestRow(env, now, resolveTitle)),
		]
		if (elided > 0) {
			lines.push(`- +${elided} more — call wait(timeout_sec=0)`)
		}
		return lines.join("\n")
	}

	/** One digest row. */
	private digestRow(env: Envelope, now: number, resolveTitle?: MailboxTitleResolver): string {
		const title = resolveTitle?.(env.from)
		const from = title ? `from ${env.from} ("${title}")` : `from ${env.from}`
		const kind = env.kind === "reply" ? `reply to ${shortId(env.in_reply_to ?? "")}` : env.kind
		const remaining = formatRemaining(remainingSeconds(env, now))
		// A request the agent has already read is the one thing in the box that is
		// waiting on the AGENT rather than on a sender, so say so explicitly.
		const awaiting = env.kind === "request" && env.read_at !== undefined ? " · awaiting your reply" : ""
		return `- ${shortId(env.id)} · ${from} · ${kind} · "${env.subject}" · ${remaining} left${awaiting}`
	}

	/**
	 * Return every live envelope in full and consume what has been consumed.
	 *
	 * Notifications and replies expect nothing further from the agent, so reading
	 * them IS receiving them and they leave the box on this call. A request is
	 * stamped `read_at` and stays: it is discharged by `reply` (or by expiry), and
	 * until then the digest keeps it visible as owed work.
	 */
	async drain(now: number = Date.now()): Promise<ReadEnvelope[]> {
		await this.hydrated()

		const pending = this.pending(now)
		if (pending.length === 0) {
			return []
		}

		const read: ReadEnvelope[] = pending.map((env) => ({
			...env,
			read_at: now,
			remaining_sec: remainingSeconds(env, now),
		}))

		for (const env of this.envelopes) {
			env.read_at = now
		}
		this.envelopes = this.envelopes.filter((env) => env.kind === "request")

		await this.persist()
		return read
	}

	/**
	 * Discharge a request by id, removing it and returning it so the caller can
	 * address the reply at its sender.
	 *
	 * Rejects rather than drops (decision 7): an id nobody can answer, or one
	 * whose deadline has already passed, is an error the replier is told about
	 * instead of a silently swallowed reply.
	 *
	 * @throws {MailboxError} `unknown-request` | `expired-request`
	 */
	async resolveRequest(id: string, now: number = Date.now()): Promise<Envelope> {
		await this.hydrated()

		// Look BEFORE sweeping so an expired request can be reported as expired
		// rather than as unknown — the two mean different things to a replier.
		const found = this.envelopes.find((env) => env.id === id && env.kind === "request")
		if (!found) {
			throw new MailboxError("unknown-request", `No request ${id} in the mailbox of task ${this.taskId}.`)
		}
		if (found.deadline <= now) {
			this.sweep(now)
			await this.persist()
			throw new MailboxError("expired-request", `Request ${id} expired and can no longer be answered.`)
		}

		this.envelopes = this.envelopes.filter((env) => env !== found)
		await this.persist()
		return found
	}

	/** Live envelopes of one kind — used by tests and by the tools added in step 2. */
	byKind(kind: MailboxKind, now: number = Date.now()): Envelope[] {
		return this.pending(now).filter((env) => env.kind === kind)
	}

	/**
	 * Drop the listeners. The envelopes and the FILE are both left alone.
	 *
	 * Clearing the in-memory array here would buy nothing (the instance is being
	 * discarded) and would create a real hazard: a `persist()` reaching a
	 * disposed mailbox would blank the durable box, silently destroying mail the
	 * recipient never read. Mail outlives any one instance of its task.
	 */
	dispose(): void {
		this.removeAllListeners()
	}
}

/** `max(0, deadline - now)` in whole seconds. */
export function remainingSeconds(envelope: Envelope, now: number = Date.now()): number {
	return Math.max(0, Math.floor((envelope.deadline - now) / 1000))
}
