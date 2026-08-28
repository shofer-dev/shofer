import { parametersSchema as z } from "@shofer/types"

import { defineNativeTool } from "../../../tools/defineNativeTool.js"

const REPLY_DESCRIPTION = `Answer one or more REQUESTS sitting in your mailbox.

Your mailbox digest, in environment_details, lists every request waiting on you and marks the ones you have already read "awaiting your reply". Answer every one of them — a request you never answer simply expires, and whoever asked learns nothing.

Replying costs you nothing: it does not end your task, it does not interrupt what you are doing, and you can answer in the same turn you read the question. Answer, then carry on with your own work.

Each item is answered independently, so an id that has already expired fails that one item and the rest of the batch still lands.

Never answer a request with attempt_completion — that would end YOUR task to say one sentence. \`reply\` is the only way to answer a request.`

const REPLIES_DESCRIPTION = `One entry per request you are answering. \`message_id\` is the request's id as shown in your mailbox digest or returned by \`wait\`; \`body\` is your answer.`

export default defineNativeTool({
	name: "reply",
	description: REPLY_DESCRIPTION,
	schema: z.object({
		replies: z
			.array(
				z.object({
					message_id: z.string().describe("The id of the request you are answering."),
					body: z.string().describe("Your answer, delivered to whoever sent the request."),
				}),
			)
			.describe(REPLIES_DESCRIPTION),
	}),
})
