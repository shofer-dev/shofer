import { describe, it, expect, vi, beforeEach } from "vitest"

import { setHost, createInMemoryHost } from "@shofer/types"

// When ripgrep isn't available, executeRipgrep throws and searchWorkspaceFiles
// swallows it — exercise the module through the host rather than vscode config.
vi.mock("../../ripgrep/index.js", () => ({ getBinPath: vi.fn(async () => null) }))

import { searchWorkspaceFiles } from "../file-search.js"

describe("file-search", () => {
	beforeEach(() => {
		setHost(createInMemoryHost())
	})

	it("returns no results when the ripgrep binary is unavailable", async () => {
		const results = await searchWorkspaceFiles("query", "/workspace", 20)
		expect(results).toEqual([])
	})
})
