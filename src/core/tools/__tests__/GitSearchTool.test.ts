import { GitSearchTool } from "../GitSearchTool"
import { GitIndexManager } from "../../../services/git-index/git-index-manager"

vi.mock("../../../services/git-index/git-index-manager", () => ({
	GitIndexManager: {
		getInstance: vi.fn(),
	},
}))

vi.mock("../../../utils/path", () => ({
	getWorkspacePath: vi.fn().mockReturnValue("/test/workspace"),
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolDenied: vi.fn().mockReturnValue("Tool denied by user."),
	},
}))

describe("GitSearchTool time-range filtering", () => {
	let gitSearchTool: GitSearchTool
	let mockSearchIndex: ReturnType<typeof vi.fn>
	let mockManager: { isFeatureEnabled: boolean; isFeatureConfigured: boolean; searchIndex: ReturnType<typeof vi.fn> }

	// Helper: build a mock GitSearchResult with the given author_date
	function makeResult(
		authorDate: string,
		overrides: Partial<{
			commit_hash: string
			short_hash: string
			author: string
			subject: string
			body: string
			score: number
		}> = {},
	) {
		return {
			id: overrides.commit_hash ?? "abc123",
			score: overrides.score ?? 0.85,
			payload: {
				commit_hash: overrides.commit_hash ?? "abc123def456",
				short_hash: overrides.short_hash ?? "abc123d",
				author: overrides.author ?? "Test User <test@example.com>",
				author_date: authorDate,
				subject: overrides.subject ?? "Test commit",
				body: overrides.body ?? "",
			},
		}
	}

	// Helper: execute git_search with given params and return the pushed result
	async function runSearch(
		searchResults: ReturnType<typeof makeResult>[],
		params: { query: string; maxResults?: number | null; since?: string | null; until?: string | null },
	) {
		mockSearchIndex.mockResolvedValue(searchResults)

		const pushToolResult = vi.fn()
		const task: any = {
			cwd: "/test/workspace",
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing param error"),
			say: vi.fn(),
			providerRef: {
				deref: () => ({ context: {} }),
			},
		}

		await gitSearchTool.execute(params as any, task, {
			askApproval: vi.fn().mockResolvedValue(true),
			pushToolResult,
			handleError: vi.fn(),
		} as any)

		return pushToolResult
	}

	beforeEach(() => {
		gitSearchTool = new GitSearchTool()
		mockSearchIndex = vi.fn()
		mockManager = {
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			searchIndex: mockSearchIndex,
		}
		vi.mocked(GitIndexManager.getInstance).mockReturnValue(mockManager as any)
		vi.clearAllMocks()
	})

	it("passes through all results when no time range is specified", async () => {
		const results = [
			makeResult("2023-01-01T00:00:00Z"),
			makeResult("2024-06-15T00:00:00Z"),
			makeResult("2025-12-31T00:00:00Z"),
		]

		const pushToolResult = await runSearch(results, { query: "test" })
		const output = pushToolResult.mock.calls[0][0]
		expect(output).toContain("2023-01-01T00:00:00Z")
		expect(output).toContain("2024-06-15T00:00:00Z")
		expect(output).toContain("2025-12-31T00:00:00Z")
	})

	it("filters out commits before the since date", async () => {
		const results = [
			makeResult("2023-01-01T00:00:00Z"),
			makeResult("2024-06-15T00:00:00Z"),
			makeResult("2025-12-31T00:00:00Z"),
		]

		const pushToolResult = await runSearch(results, {
			query: "test",
			since: "2024-01-01T00:00:00Z",
			until: null,
		})
		const output = pushToolResult.mock.calls[0][0]
		expect(output).not.toContain("2023-01-01")
		expect(output).toContain("2024-06-15")
		expect(output).toContain("2025-12-31")
	})

	it("filters out commits after the until date", async () => {
		const results = [
			makeResult("2023-01-01T00:00:00Z"),
			makeResult("2024-06-15T00:00:00Z"),
			makeResult("2025-12-31T00:00:00Z"),
		]

		const pushToolResult = await runSearch(results, {
			query: "test",
			since: null,
			until: "2024-12-31T23:59:59Z",
		})
		const output = pushToolResult.mock.calls[0][0]
		expect(output).toContain("2023-01-01")
		expect(output).toContain("2024-06-15")
		expect(output).not.toContain("2025-12-31")
	})

	it("filters out commits outside the [since, until] range when both are specified", async () => {
		const results = [
			makeResult("2023-01-01T00:00:00Z"),
			makeResult("2024-03-15T00:00:00Z"),
			makeResult("2024-09-15T00:00:00Z"),
			makeResult("2025-12-31T00:00:00Z"),
		]

		const pushToolResult = await runSearch(results, {
			query: "test",
			since: "2024-01-01T00:00:00Z",
			until: "2024-12-31T23:59:59Z",
		})
		const output = pushToolResult.mock.calls[0][0]
		expect(output).not.toContain("2023-01-01")
		expect(output).toContain("2024-03-15")
		expect(output).toContain("2024-09-15")
		expect(output).not.toContain("2025-12-31")
	})

	it("reports when all results are filtered out by the time range", async () => {
		const results = [makeResult("2023-01-01T00:00:00Z"), makeResult("2023-06-15T00:00:00Z")]

		const pushToolResult = await runSearch(results, {
			query: "test",
			since: "2024-01-01T00:00:00Z",
			until: null,
		})
		const output = pushToolResult.mock.calls[0][0]
		expect(output).toContain("No commits found in the time range")
		expect(output).toContain("since=2024-01-01T00:00:00Z")
		expect(output).toContain("2 semantic matches were filtered out")
	})

	it("reports when all results are filtered out by both since and until", async () => {
		const results = [makeResult("2023-01-01T00:00:00Z")]

		const pushToolResult = await runSearch(results, {
			query: "test",
			since: "2024-01-01T00:00:00Z",
			until: "2024-12-31T23:59:59Z",
		})
		const output = pushToolResult.mock.calls[0][0]
		expect(output).toContain("since=2024-01-01T00:00:00Z, until=2024-12-31T23:59:59Z")
		expect(output).toContain("1 semantic matches were filtered out")
	})

	it("includes commits exactly on the boundary (since is inclusive)", async () => {
		const results = [makeResult("2024-01-01T00:00:00Z"), makeResult("2024-06-15T00:00:00Z")]

		const pushToolResult = await runSearch(results, {
			query: "test",
			since: "2024-01-01T00:00:00Z",
			until: null,
		})
		const output = pushToolResult.mock.calls[0][0]
		expect(output).toContain("2024-01-01T00:00:00Z")
		expect(output).toContain("2024-06-15T00:00:00Z")
	})

	it("includes commits exactly on the boundary (until is inclusive)", async () => {
		const results = [makeResult("2024-06-15T00:00:00Z"), makeResult("2024-12-31T23:59:59Z")]

		const pushToolResult = await runSearch(results, {
			query: "test",
			since: null,
			until: "2024-12-31T23:59:59Z",
		})
		const output = pushToolResult.mock.calls[0][0]
		expect(output).toContain("2024-06-15T00:00:00Z")
		expect(output).toContain("2024-12-31T23:59:59Z")
	})

	it("excludes commits with missing author_date when time filter is active", async () => {
		const results = [
			{
				id: "no-date",
				score: 0.9,
				payload: {
					commit_hash: "nope",
					short_hash: "nope",
					author: "",
					author_date: "",
					subject: "no date",
					body: "",
				},
			},
			makeResult("2024-06-15T00:00:00Z"),
		]

		const pushToolResult = await runSearch(results, {
			query: "test",
			since: "2024-01-01T00:00:00Z",
			until: null,
		})
		const output = pushToolResult.mock.calls[0][0]
		expect(output).not.toContain("no date")
		expect(output).toContain("2024-06-15")
	})
})
