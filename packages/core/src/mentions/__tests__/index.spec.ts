// npx vitest core/mentions/__tests__/index.spec.ts

import { parseMentions } from "../index.js"

// Mock i18n
vi.mock("../../i18n/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../i18n/index.js")>()),
	t: vi.fn((key: string) => key),
}))

describe("parseMentions - URL mention handling", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should replace URL mentions with quoted URL reference", async () => {
		const result = await parseMentions("Check @https://example.com", "/test")

		// URL mentions are now replaced with a quoted reference (no fetching)
		expect(result.text).toContain("'https://example.com'")
	})
})
