import checkTaskStatusToolDef from "../check_task_status"

describe("check_task_status native tool schema", () => {
	it("declares both task_id AND include_activity as required (OpenAI strict mode)", () => {
		// OpenAI strict-mode JSON Schema requires every property in `properties`
		// to also appear in `required`. The original schema omitted
		// include_activity from `required`, which produces a 400 from the
		// OpenAI endpoint with strict=true.
		const params = checkTaskStatusToolDef.function.parameters as {
			properties: Record<string, unknown>
			required: string[]
		}
		expect(params.required).toEqual(expect.arrayContaining(["task_id", "include_activity"]))
		expect(Object.keys(params.properties).sort()).toEqual([...params.required].sort())
	})

	it("uses ['boolean','null'] union for the optional include_activity flag", () => {
		const params = checkTaskStatusToolDef.function.parameters as {
			properties: Record<string, { type: string | string[] }>
		}
		expect(params.properties.include_activity.type).toEqual(["boolean", "null"])
	})
})
