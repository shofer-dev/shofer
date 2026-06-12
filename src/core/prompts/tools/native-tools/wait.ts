import type OpenAI from "openai"

const WAIT_DESCRIPTION = `Wait for an incoming message. Call this tool WHENEVER you have nothing to do right now except wait for a message, reply, or signal to arrive from another task, a peer, or the orchestrator.

This is the CORRECT and ONLY way to wait. Do NOT loop, poll, re-read state, or call other tools to "pass the time" — that wastes turns and tokens. The moment you find yourself waiting for a message to arrive, call \`wait\`. You will be automatically resumed and re-activated as soon as a message arrives, so it is always safe to wait.

Typical triggers — call \`wait\` immediately if any of these is true:
- You sent a message to a peer task and are waiting for its reply.
- You delegated work and are waiting for a result or a notification.
- You have been told to wait for further instructions or for an event.
- You have completed everything you can do until someone messages you.

Mechanically this yields control like \`attempt_completion\` (it ends the current turn and returns control), but you do NOT need to formulate a full result — just rate the work done so far and optionally say what you are waiting for.

Parameters:
- rating: (required) A self-assessment of the work you have completed so far, up to this point of waiting. One of "poor" (significant issues or incomplete), "well" (acceptable, room for improvement), or "excellent" (high quality).
- reason: (optional) A short note on what you are waiting for. Defaults to "waiting" if omitted.

Example: { "rating": "well", "reason": "waiting for a reply from the research task" }`

export default {
	type: "function",
	function: {
		name: "wait",
		description: WAIT_DESCRIPTION,
		// `rating` is required, but `reason` is optional/advisory with a host-side
		// default, so this schema is intentionally NOT strict (OpenAI Structured
		// Outputs with strict: true would force the model to emit every property,
		// including `reason`). See the Advisory Parameter Defaults Rule in
		// docs/adding-new-tools.md.
		parameters: {
			type: "object",
			properties: {
				rating: {
					type: "string",
					description:
						"Self-assessment of the work you have completed so far: 'poor', 'well', or 'excellent'.",
					enum: ["poor", "well", "excellent"],
				},
				reason: {
					type: "string",
					description: "Short reason for waiting / what you are waiting on. Defaults to 'waiting'.",
				},
			},
			required: ["rating"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
