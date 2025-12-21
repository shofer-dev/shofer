import type { CustomToolContext, TaskLike } from "@roo-code/types"

import systemTime from "../system-time.js"

const mockContext: CustomToolContext = {
	mode: "code",
	task: { taskId: "test-task-id" } as unknown as TaskLike,
}

describe("system-time tool", () => {
	describe("execute", () => {
		it("should return a formatted date/time string", async () => {
			const result = await systemTime.execute({}, mockContext)
			expect(result).toMatch(/^The current date and time is:/)
			expect(result).toMatch(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/)
			expect(result).toMatch(
				/(January|February|March|April|May|June|July|August|September|October|November|December)/,
			)
			expect(result).toMatch(/\d{1,2}:\d{2}:\d{2}/)
		})
	})
})
