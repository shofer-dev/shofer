import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "../../../tools/defineNativeTool.js"

const SEND_MESSAGE_DESCRIPTION = `Put a message in another task's MAILBOX. This is the one way to talk to another task.

The recipient's state is never consulted — there is no busy check and no rejection for a task that is running, parked, or already finished. A message is accepted or it is refused with a reason; it is never dropped.

WHO YOU MAY ADDRESS: a task sharing your root task. If you are a sub-task, the target must also be in the peer set you were granted at spawn time (peer_task_ids) — discover ids with list_background_tasks(scope="peers"). The root task may address anything in its own tree.

KINDS:
- "notification" (default) — you expect no answer. Delivered and forgotten once the recipient reads it.
- "request" — you expect an answer. The recipient sees it in its mailbox digest and answers with the \`reply\` tool. Its id is what you pass to wait(in_reply_to=...).

THE IDIOM, and it matters:
- If you need the answer BEFORE you can continue, send a request and then call wait(in_reply_to="<the id this tool returned>").
- If you do NOT need the answer right now, send it and CARRY ON. Do not wait for the sake of waiting.
- If you have nothing left to do, just end your turn. A message that arrives with wake=true restarts you automatically, so ending your turn is safe and costs nothing.
- NEVER poll. Do not loop, re-send, or call other tools to pass the time.

Every message carries a deadline. When it expires it leaves the recipient's mailbox unread, so pick a timeout_sec that reflects how long the message stays worth reading.`

const TO_DESCRIPTION = `The recipient's task id. Must share your root task; as a sub-task you must also hold it in your granted peer set. Discover ids with list_background_tasks(scope="peers").`

const BODY_DESCRIPTION = `The message itself. This is what the recipient reads in full when it calls \`wait\`.`

const KIND_DESCRIPTION = `"notification" (default) if you expect no answer, "request" if you do. A request is answered with the \`reply\` tool and can be awaited with wait(in_reply_to=...). You cannot send a "reply" with this tool — use \`reply\`.`

const SUBJECT_DESCRIPTION = `A short one-line summary, shown in the recipient's mailbox digest. Omit it and the first 80 characters of the body are used.`

const TIMEOUT_SEC_DESCRIPTION = `Seconds until the message expires out of the recipient's mailbox. Defaults to 120 for a request and 600 for a notification.`

const WAKE_DESCRIPTION = `Whether a recipient whose loop has stopped should be resumed for this message. Defaults to true for a request and false for a notification. Leave it alone unless you know the recipient should be woken (or should not be).`

// strict: false is intentional — every parameter but `to` and `body` is
// advisory, and the handler applies a default for each. Under OpenAI strict
// mode all of them would land in `required`.
export default defineNativeTool({
	name: "send_message",
	description: SEND_MESSAGE_DESCRIPTION,
	strict: false,
	schema: z.object({
		to: z.string().describe(TO_DESCRIPTION),
		body: z.string().describe(BODY_DESCRIPTION),
		kind: z.enum(["notification", "request"]).describe(KIND_DESCRIPTION).optional(),
		subject: z.string().describe(SUBJECT_DESCRIPTION).optional(),
		timeout_sec: z.number().describe(TIMEOUT_SEC_DESCRIPTION).optional(),
		wake: z.boolean().describe(WAKE_DESCRIPTION).optional(),
	}),
})
