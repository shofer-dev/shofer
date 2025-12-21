import { parametersSchema, defineCustomTool } from "@roo-code/types"

export default defineCustomTool({
	name: "system_time",
	description: "Returns the current system date and time in a friendly, human-readable format.",
	parameters: parametersSchema.object({}),
	async execute() {
		const systemTime = new Date().toLocaleString("en-US", {
			weekday: "long",
			year: "numeric",
			month: "long",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			timeZoneName: "short",
			timeZone: "America/Los_Angeles",
		})

		return `The current date and time is: ${systemTime}`
	},
})
