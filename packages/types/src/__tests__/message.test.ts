// pnpm --filter @shofer/types test src/__tests__/message.test.ts

import { shoferAsks, isIdleAsk, isInteractiveAsk, isResumableAsk, isNonBlockingAsk } from "../message.js"

describe("ask messages", () => {
	test("all ask messages are classified", () => {
		for (const ask of shoferAsks) {
			expect(
				isIdleAsk(ask) || isInteractiveAsk(ask) || isResumableAsk(ask) || isNonBlockingAsk(ask),
				`${ask} is not classified`,
			).toBe(true)
		}
	})
})
