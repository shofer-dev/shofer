import type OpenAI from "openai"

const ASK_FOLLOWUP_QUESTION_DESCRIPTION = `Ask the user a question to gather additional information needed to complete the task. Use when you need clarification or more details to proceed effectively.

There are two ways to collect the answer — provide EXACTLY ONE (never both); set the other to null:
- follow_up: a short list of one-click suggested answers (best for simple either/or or pick-one-of-a-few choices).
- form: a typed input form rendering rich widgets (dropdown, radio, multi-select checkboxes, slider, number, free-text, boolean toggle). Best when you need structured, validated, or multiple values at once. The user's answers are returned as a JSON object keyed by each field's name.

Parameters:
- question: (required) A clear, specific question addressing the information needed.
- follow_up: (optional — provide this OR form, null when unused) A list of 2-4 suggested answers. Suggestions must be complete, actionable answers without placeholders. Optionally include mode to switch modes (code/architect/etc.).
- form: (optional — provide this OR follow_up, null when unused) A list of typed input fields. Each field has a name (the JSON key the answer is returned under) and a type (string/number/boolean), plus optional presentation metadata that selects the widget.

Providing both follow_up and form is rejected — choose one answer channel.

Form widget selection (per field):
- options present + widget "dropdown" (or omitted) → single-select dropdown
- options present + widget "radio" → radio buttons
- options present + widget "checkbox" → multi-select checkboxes (answer is an array of strings)
- type "number" + widget "slider" (or min+max set) → slider
- type "number" otherwise → number input
- type "string" with no options → multiline free-text box
- type "boolean" → single checkbox toggle

Example: simple suggested answers
{ "question": "What is the path to the frontend-config.json file?", "follow_up": [{ "text": "./src/frontend-config.json", "mode": null }, { "text": "./config/frontend-config.json", "mode": null }], "form": null }

Example: suggested answers with a mode switch
{ "question": "Would you like me to implement this feature?", "follow_up": [{ "text": "Yes, implement it now", "mode": "code" }, { "text": "No, just plan it out", "mode": "architect" }], "form": null }

Example: structured input form with mixed widgets
{ "question": "Configure the new service:", "follow_up": null, "form": [
  { "name": "service_name", "type": "string", "description": "Name of the service", "default": "my-service", "widget": null, "options": null, "min": null, "max": null, "step": null },
  { "name": "runtime", "type": "string", "description": "Language runtime", "widget": "radio", "options": ["node", "python", "go"], "default": "node", "min": null, "max": null, "step": null },
  { "name": "regions", "type": "string", "description": "Deploy to which regions", "widget": "checkbox", "options": ["us-east", "us-west", "eu", "asia"], "default": null, "min": null, "max": null, "step": null },
  { "name": "replicas", "type": "number", "description": "Replica count", "widget": "slider", "min": 1, "max": 10, "step": 1, "default": 3, "options": null },
  { "name": "enable_logs", "type": "boolean", "description": "Enable verbose logging", "default": true, "widget": null, "options": null, "min": null, "max": null, "step": null }
] }`

const QUESTION_PARAMETER_DESCRIPTION = `Clear, specific question that captures the missing information you need`

const FOLLOW_UP_PARAMETER_DESCRIPTION = `Optional list of 2-4 one-click suggested responses; each suggestion must be a complete, actionable answer and may include a mode switch. Pass null when using a form instead.`

const FOLLOW_UP_TEXT_DESCRIPTION = `Suggested answer the user can pick`

const FOLLOW_UP_MODE_DESCRIPTION = `Optional mode slug to switch to if this suggestion is chosen (e.g., code, architect). Use null for no switch.`

const FORM_PARAMETER_DESCRIPTION = `Optional list of typed input fields rendered as a form (dropdown/radio/checkbox/slider/number/text/boolean). Answers are returned as a JSON object keyed by each field's name. Pass null when using follow_up suggestions instead.`

const FORM_NAME_DESCRIPTION = `Field name — the JSON key the user's answer is returned under`
const FORM_TYPE_DESCRIPTION = `Base data type, drives answer coercion: "string", "number", or "boolean"`
const FORM_DESCRIPTION_DESCRIPTION = `Optional markdown description shown beneath the field label (null for none)`
const FORM_WIDGET_DESCRIPTION = `Optional presentation widget: "dropdown", "radio", "checkbox" (multi-select), or "slider". null = infer from type/options`
const FORM_OPTIONS_DESCRIPTION = `Allowed values for dropdown/radio/checkbox widgets (null when not a choice field)`
const FORM_MIN_DESCRIPTION = `Slider/number lower bound (null when unused)`
const FORM_MAX_DESCRIPTION = `Slider/number upper bound (null when unused)`
const FORM_STEP_DESCRIPTION = `Slider step increment (null when unused)`
const FORM_DEFAULT_DESCRIPTION = `Optional default value used when the field is left blank (null for none)`

export default {
	type: "function",
	function: {
		name: "ask_followup_question",
		description: ASK_FOLLOWUP_QUESTION_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				question: {
					type: "string",
					description: QUESTION_PARAMETER_DESCRIPTION,
				},
				follow_up: {
					type: ["array", "null"],
					description: FOLLOW_UP_PARAMETER_DESCRIPTION,
					items: {
						type: "object",
						properties: {
							text: {
								type: "string",
								description: FOLLOW_UP_TEXT_DESCRIPTION,
							},
							mode: {
								type: ["string", "null"],
								description: FOLLOW_UP_MODE_DESCRIPTION,
							},
						},
						required: ["text", "mode"],
						additionalProperties: false,
					},
				},
				form: {
					type: ["array", "null"],
					description: FORM_PARAMETER_DESCRIPTION,
					items: {
						type: "object",
						properties: {
							name: {
								type: "string",
								description: FORM_NAME_DESCRIPTION,
							},
							type: {
								type: "string",
								enum: ["string", "number", "boolean"],
								description: FORM_TYPE_DESCRIPTION,
							},
							description: {
								type: ["string", "null"],
								description: FORM_DESCRIPTION_DESCRIPTION,
							},
							widget: {
								type: ["string", "null"],
								enum: ["dropdown", "radio", "checkbox", "slider", null],
								description: FORM_WIDGET_DESCRIPTION,
							},
							options: {
								type: ["array", "null"],
								items: { type: "string" },
								description: FORM_OPTIONS_DESCRIPTION,
							},
							min: {
								type: ["number", "null"],
								description: FORM_MIN_DESCRIPTION,
							},
							max: {
								type: ["number", "null"],
								description: FORM_MAX_DESCRIPTION,
							},
							step: {
								type: ["number", "null"],
								description: FORM_STEP_DESCRIPTION,
							},
							default: {
								type: ["string", "number", "boolean", "null"],
								description: FORM_DEFAULT_DESCRIPTION,
							},
						},
						required: ["name", "type", "description", "widget", "options", "min", "max", "step", "default"],
						additionalProperties: false,
					},
				},
			},
			required: ["question", "follow_up", "form"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
