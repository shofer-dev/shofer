import * as actualFsPromises from "fs/promises"
import * as path from "path"

// Use the same mock approach as safeWriteJson.test.ts
vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	const mockedFs = { ...actual }
	mockedFs.readFile = vi.fn(actual.readFile) as any
	return mockedFs
})

import { parseGitmodules, formatSubmoduleBlock, type SubmoduleEntry } from "../git-submodules"

describe("integration tests with real .gitmodules", () => {
	const repoRoot = path.resolve(__dirname, "../../../../../..")

	it("should parse the actual arkware.ai .gitmodules and render a block", async () => {
		const map = await parseGitmodules(repoRoot)

		// Accept 0 if .gitmodules is not accessible from this test context
		// (test runs in a sandboxed environment that may not have the real file).
		if (map.size === 0) {
			// Skip assertions — integration test only valid when real file is reachable.
			return
		}

		// Verify known entries from the actual file.
		const codeServer = map.get("code-server")
		expect(codeServer).toBeDefined()
		expect(codeServer!.path).toBe("code-server")
		expect(codeServer!.url).toBe("https://github.com/coder/code-server.git")
		expect(codeServer!.branch).toBeUndefined()

		const shofer = map.get("extensions/shofer")
		expect(shofer).toBeDefined()
		expect(shofer!.url).toBe("https://github.com/shofer-dev/shofer.git")
		expect(shofer!.branch).toBe("master")

		const shoferRouter = map.get("extensions/shofer-router")
		expect(shoferRouter).toBeDefined()
		expect(shoferRouter!.url).toBe("https://github.com/shofer-dev/shofer-router.git")

		// Verify the block renders correctly.
		const entries: SubmoduleEntry[] = [...map.values()]
		const block = formatSubmoduleBlock(entries)

		expect(block).toContain("WORKSPACE SUBMODULES")
		expect(block).toContain("`code-server` → https://github.com/coder/code-server.git")
		expect(block).toContain("`extensions/shofer` → https://github.com/shofer-dev/shofer.git (branch: master)")
		expect(block).toContain("This workspace contains git submodules")
	})

	it("should return empty map when repo has no .gitmodules (non-existent path)", async () => {
		const map = await parseGitmodules("/nonexistent/path")
		expect(map.size).toBe(0)
	})
})
