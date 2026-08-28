/**
 * The agent mailbox wire shape.
 *
 * Every message that reaches an agent — from an in-process peer, the pub/sub
 * bus, an A2A relay or a Temporal owner — arrives as one {@link Envelope}. The
 * schema lives here (rather than beside the `Mailbox` implementation) because
 * it crosses boundaries: it is persisted per task, carried over the AgentApi's
 * mailbox route, and handed to plugins through the delivery seam. Consumers
 * take the inferred type; nobody re-declares the shape.
 *
 * Two properties of the design are load-bearing and are enforced here rather
 * than at each call site:
 *
 * - **`deadline` is absolute** (epoch ms), never a duration. Every read surface
 *   derives the REMAINING time at read time, so a message that sat in a
 *   persisted box across a restart expires on schedule instead of getting a
 *   fresh lease. Expiry is applied lazily when the box is read — there are no
 *   timers anywhere in this subsystem.
 * - **`wake` is chosen by the SENDER**, which knows whether the recipient
 *   should be resumed for this message or should simply find it on its next
 *   turn. Locally the flag is authoritative; across a trust boundary the
 *   receiving host polices it.
 */

import { z } from "zod"

/**
 * Maximum envelopes one mailbox holds. A delivery into a full box is REFUSED
 * (loudly, at the sender) rather than silently dropping the oldest message —
 * a mailbox that quietly forgets is worse than one that says it is full.
 */
export const MAILBOX_CAPACITY = 200

/** Maximum digest rows rendered into `environment_details`; the rest are counted. */
export const MAILBOX_DIGEST_MAX_ROWS = 20

/** Hard cap on an envelope's subject, enforced by {@link envelopeSchema}. */
export const MAILBOX_SUBJECT_MAX_LENGTH = 120

/**
 * How much of the body a derived subject keeps when the sender supplied none.
 * Shorter than {@link MAILBOX_SUBJECT_MAX_LENGTH} on purpose: a derived subject
 * is a preview, not a title, and should read as one.
 */
export const MAILBOX_SUBJECT_DERIVED_MAX_LENGTH = 80

/**
 * What an envelope is FOR.
 *
 * - `notification` — no reply expected; removed once read in full.
 * - `request` — a reply is expected, correlated by `in_reply_to`; survives in
 *   the box until it is replied to or expires.
 * - `reply` — the answer to a request; carries the request's id.
 */
export const mailboxKindSchema = z.enum(["notification", "request", "reply"])

export type MailboxKind = z.infer<typeof mailboxKindSchema>

/**
 * The transport the envelope arrived on. Informational — the mailbox treats
 * every plane identically; the field exists so a reader can tell an in-process
 * peer from a bus event without decoding the `from` address.
 */
export const mailboxPlaneSchema = z.enum(["local", "bus", "a2a", "temporal"])

export type MailboxPlane = z.infer<typeof mailboxPlaneSchema>

export const envelopeSchema = z
	.object({
		/**
		 * Sender-minted UUIDv4, and the A2A `message_id` when the envelope
		 * crosses the mesh. It is the IDEMPOTENCY KEY: a mailbox that already
		 * holds this id acknowledges the delivery without appending it again,
		 * which is what makes a relay retry safe.
		 */
		id: z.string().min(1),
		/**
		 * Who sent it: a task id (in-process / A2A), a tag address (bus), or an
		 * owner label (Temporal).
		 */
		from: z.string().min(1),
		/** The recipient task id. A mailbox refuses an envelope addressed elsewhere. */
		to: z.string().min(1),
		kind: mailboxKindSchema,
		/** The `id` of the request being answered. Required when `kind` is `reply`. */
		in_reply_to: z.string().min(1).optional(),
		/** Provided by the sender, or derived from the body via {@link deriveSubject}. */
		subject: z.string().max(MAILBOX_SUBJECT_MAX_LENGTH),
		body: z.string(),
		/** Absolute expiry, epoch ms. Past this instant the envelope is not delivered and not read. */
		deadline: z.number(),
		/** Whether a delivery to a stopped agent loop should resume it. */
		wake: z.boolean(),
		sent_at: z.number(),
		plane: mailboxPlaneSchema,
		/**
		 * Set when the envelope was returned IN FULL to the agent. A notification
		 * or reply is removed on the same read; a request keeps the stamp so the
		 * digest can mark it "awaiting your reply".
		 */
		read_at: z.number().optional(),
	})
	.refine((env) => env.kind !== "reply" || typeof env.in_reply_to === "string", {
		message: 'in_reply_to is required when kind is "reply"',
		path: ["in_reply_to"],
	})

export type Envelope = z.infer<typeof envelopeSchema>

/**
 * The subject to use when the sender supplied none: the head of the body,
 * whitespace-collapsed, clipped to {@link MAILBOX_SUBJECT_DERIVED_MAX_LENGTH}
 * with an ellipsis so a truncated preview is visibly truncated.
 */
export function deriveSubject(body: string): string {
	const collapsed = body.replace(/\s+/g, " ").trim()
	if (collapsed.length <= MAILBOX_SUBJECT_DERIVED_MAX_LENGTH) {
		return collapsed
	}
	return `${collapsed.slice(0, MAILBOX_SUBJECT_DERIVED_MAX_LENGTH - 1)}…`
}

/**
 * The synthesized user turn that resumes a stopped agent loop for a `wake`
 * delivery.
 *
 * It is PLAIN TEXT and says nothing that could read as a decision, because
 * `Task.ask()` drains the message queue as an auto-approval for tool and
 * command asks: a wake turn phrased as an instruction could be consumed as an
 * answer to whatever the task was parked on.
 *
 * It is also a fixed string, which is what makes coalescing possible — a second
 * `wake` arriving before the first turn is drained must not queue a second one.
 */
export const MAILBOX_WAKE_TURN_TEXT =
	"You have new mail. Call wait(timeout_sec=0) to read it; the digest in environment_details lists it."
