/**
 * Smoke coverage for the package's declared entrypoints.
 *
 * `package.json#exports` publishes four surfaces — `.` (`src/index.ts`),
 * `./cli`, `./browser` and `./fixtures` — plus the internal barrels the host
 * imports as a unit (`tools/index.ts`, `transport/index.ts`,
 * `terminal/index.ts`, `tools/apply-patch/index.ts`). A barrel is not inert:
 * `export *` executes every re-exported module, so a module that throws at
 * import time (a bad top-level `await`, a circular initializer, a missing
 * dependency) breaks the whole entrypoint for every consumer while each
 * module's own unit tests stay green — they import the module directly and
 * never go through the barrel.
 *
 * These tests therefore assert the two things a barrel can get wrong: that it
 * loads at all, and that the symbols consumers name are actually on it.
 */

describe("package entrypoints", () => {
	// The main barrel transitively loads ~300 modules (every provider SDK, the
	// plugin system, the MCP hub). Alone that is ~10s; sharing a saturated worker
	// pool with the rest of the suite it comfortably crosses the package's 30s
	// default, and the failure reads as a hang rather than as scheduling.
	it("loads the main barrel and re-exports the core surfaces", async () => {
		const core = await import("../index.js")

		// One representative symbol per major re-exported subsystem, so a
		// dropped `export *` line fails here rather than at a consumer.
		expect(typeof core.buildApiHandler).toBe("function")
		expect(typeof core.PluginManager).toBe("function")
		expect(typeof core.Task).toBe("function")
		expect(typeof core.listFiles).toBe("function")
		expect(typeof core.McpHub).toBe("function")
	}, 180_000)

	it("loads the CLI barrel without pulling a host-only module", async () => {
		const cli = await import("../cli.js")

		expect(typeof cli.loadLayeredOverlay).toBe("function")
		expect(typeof cli.resolveScopeRoots).toBe("function")
		expect(typeof cli.isPathLocked).toBe("function")
		expect(typeof cli.PluginManager).toBe("function")
		expect(cli.SCOPE_SETTINGS_FILE).toBeTruthy()
	}, 120_000)

	it("loads the browser barrel", async () => {
		const browser = await import("../browser.js")

		expect(typeof browser.safeJsonParse).toBe("function")
		expect(typeof browser.consolidateTokenUsage).toBe("function")
	})

	it("loads the fixtures barrel", async () => {
		const fixtures = await import("../__fixtures__/index.js")

		expect(fixtures).toBeTruthy()
		expect(Object.keys(fixtures).length).toBeGreaterThan(0)
	})

	it("loads the tools barrel with every tool class on it", async () => {
		const tools = await import("../tools/index.js")

		for (const name of [
			"ApplyDiffTool",
			"ApplyPatchTool",
			"AttemptCompletionTool",
			"ExecuteCommandTool",
			"FileTool",
			"NewTaskTool",
			"ReadFileTool",
			"WriteToFileTool",
		]) {
			expect(typeof (tools as Record<string, unknown>)[name], name).toBe("function")
		}
	}, 120_000)

	it("loads the transport barrel with both host entrypoints", async () => {
		const transport = await import("../transport/index.js")

		expect(typeof transport.serveHttpOverShoferApi).toBe("function")
		expect(typeof transport.runAcpAgentOverShoferApi).toBe("function")
		expect(typeof transport.ShoferApiAgent).toBe("function")
		expect(Array.isArray(transport.FORWARDED_EVENTS)).toBe(true)
	}, 120_000)

	it("loads the terminal and apply-patch barrels", async () => {
		const terminal = await import("../terminal/index.js")
		const applyPatch = await import("../tools/apply-patch/index.js")

		expect(Object.keys(terminal).length).toBeGreaterThan(0)
		expect(Object.keys(applyPatch).length).toBeGreaterThan(0)
	})
})
