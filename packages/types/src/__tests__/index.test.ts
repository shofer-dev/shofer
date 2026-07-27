// npx vitest run src/__tests__/index.test.ts

import { GLOBAL_STATE_KEYS } from "../index.js"

describe("GLOBAL_STATE_KEYS", () => {
	it("should contain provider settings keys", () => {
		expect(GLOBAL_STATE_KEYS).toContain("autoApprovalEnabled")
	})

	it("should contain provider settings keys", () => {
		expect(GLOBAL_STATE_KEYS).toContain("anthropicBaseUrl")
	})

	it("should not contain secret state keys", () => {
		expect(GLOBAL_STATE_KEYS).not.toContain("openRouterApiKey")
	})

	it("no longer contains the code-index settings — they are the rag-indexing plugin's", () => {
		// The indexer's provider/model/URL settings and its seven credentials moved into
		// the plugin's own `config` schema when the feature left core; neither half should
		// reappear in the global settings surface.
		expect(GLOBAL_STATE_KEYS).not.toContain("codebaseIndexConfig")
		expect(GLOBAL_STATE_KEYS).not.toContain("codebaseIndexOpenAiCompatibleBaseUrl")
		expect(GLOBAL_STATE_KEYS).not.toContain("codebaseIndexOpenAiCompatibleApiKey")
	})
})
