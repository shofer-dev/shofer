import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "../../../tools/defineNativeTool.js"

const WAIT_DESCRIPTION = `Read your MAILBOX, parking until something arrives if it is empty.

WHAT IT RETURNS: everything in your box, in full — every notification, request and reply, each with the time it has left. If the box already has something in it the tool returns immediately. If it is empty it parks, event-driven, and returns the moment anything is delivered or when the timeout expires. A timeout with an empty box returns an empty list; that is a normal answer, not an error.

WHEN TO CALL IT:
- wait(timeout_sec=0) — check the box and return at once. Use this when the digest in environment_details shows mail and you want to read it now.
- wait(in_reply_to="<id>") — you sent a request and cannot continue without the answer.
- wait(from=["<task id>", ...]) — you are blocked on something specific from particular tasks.
- wait(timeout_sec=N) — you genuinely need to let time pass. It returns EARLY if mail arrives, which is what you actually wanted.

THE FILTERS ARE ONLY A WAKE CONDITION. \`from\` and \`in_reply_to\` decide WHEN a parked wait returns; they never decide what it returns. You always get the whole box.

WHEN NOT TO CALL IT: if you have other work you can do, do that work instead — the mail keeps. If you have nothing left to do at all, prefer ENDING YOUR TURN over parking here: a message sent with wake restarts you automatically. Parking is for when you must have an answer before your very next step.

NEVER POLL. Do not loop on wait, do not re-check the box repeatedly, and do not call other tools to pass the time. One wait, with a timeout that reflects how long the answer is worth having.

Reading a message consumes it: notifications and replies leave your box once returned here. A request stays until you answer it with \`reply\`.`

const TIMEOUT_SEC_DESCRIPTION = `How many seconds to park when the box is empty. Default 120. Use 0 to check the box and return immediately.`

const FROM_DESCRIPTION = `Wake condition: return as soon as a message from any of these task ids arrives. Does not filter what is returned — you always get the whole box.`

const IN_REPLY_TO_DESCRIPTION = `Wake condition: return as soon as the reply to this request id arrives. This is the id \`send_message\` returned for the request. Does not filter what is returned.`

// strict: false is intentional — all three parameters are advisory and the
// handler defaults each; strict mode would force them into `required`.
export default defineNativeTool({
	name: "wait",
	description: WAIT_DESCRIPTION,
	strict: false,
	schema: z.object({
		timeout_sec: z.number().describe(TIMEOUT_SEC_DESCRIPTION).optional(),
		from: z.array(z.string()).describe(FROM_DESCRIPTION).optional(),
		in_reply_to: z.string().describe(IN_REPLY_TO_DESCRIPTION).optional(),
	}),
})
