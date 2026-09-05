/**
 * Unit tests for the commander program (`src/index.ts`) — the CLI's argv
 * surface.
 *
 * `src/index.ts` calls `program.parse()` at module scope, so each case here
 * resets the module registry, plants an argv, and re-imports it. Every command
 * implementation is faked (`@/commands/index.js` is mocked wholesale), which
 * keeps the assertions about ARGV → handler wiring: what a flag is named, what
 * it parses to, what its default is, and how a failing handler is reported.
 *
 * `process.exit` is a recording no-op here (the real one never returns, but the
 * three `run*Action` wrappers call it as their last statement, so a no-op
 * changes nothing).
 */

const handlers = vi.hoisted(() => ({
	run: vi.fn(async (..._args: unknown[]) => {}),
	listCommands: vi.fn(async (..._args: unknown[]) => {}),
	listModes: vi.fn(async (..._args: unknown[]) => {}),
	listModels: vi.fn(async (..._args: unknown[]) => {}),
	listSessions: vi.fn(async (..._args: unknown[]) => {}),
	upgrade: vi.fn(async (..._args: unknown[]) => {}),
	acp: vi.fn(async (..._args: unknown[]) => {}),
	serve: vi.fn(async (..._args: unknown[]) => {}),
	pluginInstall: vi.fn(async (..._args: unknown[]) => {}),
	pluginList: vi.fn(async (..._args: unknown[]) => {}),
	pluginPack: vi.fn(async (..._args: unknown[]) => {}),
	pluginRemove: vi.fn(async (..._args: unknown[]) => {}),
}))

vi.mock("@/commands/index.js", () => handlers)

/** Narrow alias so the spy keeps `process.exit`'s own signature. */
const _spyOnExit = () => vi.spyOn(process, "exit")
let exitSpy: ReturnType<typeof _spyOnExit>
let errorLines: string[]

/** Re-import the program with `argv` in place, then let its action settle. */
async function cli(...argv: string[]): Promise<void> {
	const previous = process.argv
	process.argv = ["/usr/bin/node", "/usr/local/bin/shofer", ...argv]
	vi.resetModules()

	try {
		await import("../index.js")
	} finally {
		process.argv = previous
	}

	await new Promise((resolve) => setImmediate(resolve))
}

describe("shofer program", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		errorLines = []
		exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errorLines.push(args.map(String).join(" "))
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	const exitCodes = () => exitSpy.mock.calls.map((call) => call[0])

	describe("the default (run) command", () => {
		it("passes the positional prompt and the flag defaults through", async () => {
			await cli("say hello")

			expect(handlers.run).toHaveBeenCalledTimes(1)
			const [prompt, options] = handlers.run.mock.calls[0] as unknown as [string, Record<string, unknown>]
			expect(prompt).toBe("say hello")
			expect(options).toMatchObject({
				continue: false,
				print: false,
				stdinPromptStream: false,
				signalOnlyExit: false,
				debug: false,
				requireApproval: false,
				exitOnError: false,
				ephemeral: false,
				oneshot: false,
				mode: "code",
				reasoningEffort: "medium",
				retry: 0,
				outputFormat: "text",
			})
		})

		it("accepts an invocation with no prompt at all", async () => {
			await cli()

			const [prompt] = handlers.run.mock.calls[0] as unknown as [string | undefined]
			expect(prompt).toBeUndefined()
		})

		it("maps the short flags onto their long names", async () => {
			await cli("-p", "-d", "-a", "-c", "-k", "sk-test", "-m", "a/b", "-w", "/tmp", "-e", "/ext", "-r", "high")

			const [, options] = handlers.run.mock.calls[0] as unknown as [string, Record<string, unknown>]
			expect(options).toMatchObject({
				print: true,
				debug: true,
				requireApproval: true,
				continue: true,
				apiKey: "sk-test",
				model: "a/b",
				workspace: "/tmp",
				extension: "/ext",
				reasoningEffort: "high",
			})
		})

		it("parses the numeric flags as integers", async () => {
			await cli("--consecutive-mistake-limit", "7", "--retry", "3", "hi")

			const [prompt, options] = handlers.run.mock.calls[0] as unknown as [string, Record<string, unknown>]
			expect(prompt).toBe("hi")
			expect(options.consecutiveMistakeLimit).toBe(7)
			expect(options.retry).toBe(3)
		})

		it("passes anything after the prompt through untouched (passThroughOptions)", async () => {
			// `enablePositionalOptions()` + `passThroughOptions()` mean the first
			// operand ends option parsing, so a prompt may contain dashes freely —
			// and flags meant for shofer have to precede it.
			await cli("summarise --print for me")

			const [prompt, options] = handlers.run.mock.calls[0] as unknown as [string, Record<string, unknown>]
			expect(prompt).toBe("summarise --print for me")
			expect(options.print).toBe(false)
		})

		it("carries the session, stream and output-format flags", async () => {
			await cli(
				"--session-id",
				"abc",
				"--stdin-prompt-stream",
				"--signal-only-exit",
				"--output-format",
				"stream-json",
				"--base-url",
				"http://localhost:30081/v1",
				"--provider",
				"shofer",
				"--terminal-shell",
				"/bin/sh",
				"--prompt-file",
				"/tmp/p.md",
				"--create-with-session-id",
				"xyz",
				"--ephemeral",
				"--oneshot",
				"--exit-on-error",
			)

			const [, options] = handlers.run.mock.calls[0] as unknown as [string, Record<string, unknown>]
			expect(options).toMatchObject({
				sessionId: "abc",
				stdinPromptStream: true,
				signalOnlyExit: true,
				outputFormat: "stream-json",
				baseUrl: "http://localhost:30081/v1",
				provider: "shofer",
				terminalShell: "/bin/sh",
				promptFile: "/tmp/p.md",
				createWithSessionId: "xyz",
				ephemeral: true,
				oneshot: true,
				exitOnError: true,
			})
		})
	})

	describe("list subcommands", () => {
		it.each([
			["commands", () => handlers.listCommands],
			["modes", () => handlers.listModes],
			["models", () => handlers.listModels],
			["sessions", () => handlers.listSessions],
		])("routes `list %s` and exits 0", async (name, handler) => {
			await cli("list", name)

			expect(handler()).toHaveBeenCalledTimes(1)
			expect(handler().mock.calls[0]![0]).toMatchObject({ format: "json", debug: false })
			expect(exitCodes()).toContain(0)
		})

		it("passes the shared list options through", async () => {
			await cli("list", "commands", "-w", "/tmp", "-e", "/ext", "-k", "sk-test", "--format", "text", "-d")

			expect(handlers.listCommands.mock.calls[0]![0]).toMatchObject({
				workspace: "/tmp",
				extension: "/ext",
				apiKey: "sk-test",
				format: "text",
				debug: true,
			})
		})

		it("reports a failing list command and exits 1", async () => {
			handlers.listModes.mockRejectedValueOnce(new Error("no extension bundle"))

			await cli("list", "modes")

			expect(errorLines.join("\n")).toContain("[CLI] Error: no extension bundle")
			expect(exitCodes()).toContain(1)
		})

		it("stringifies a non-Error list failure", async () => {
			handlers.listSessions.mockRejectedValueOnce("bare string")

			await cli("list", "sessions")

			expect(errorLines.join("\n")).toContain("[CLI] Error: bare string")
			expect(exitCodes()).toContain(1)
		})
	})

	describe("upgrade", () => {
		it("runs the upgrade and exits 0", async () => {
			await cli("upgrade")

			expect(handlers.upgrade).toHaveBeenCalledTimes(1)
			expect(exitCodes()).toContain(0)
		})

		it("reports a failing upgrade and exits 1", async () => {
			handlers.upgrade.mockRejectedValueOnce(new Error("github unreachable"))

			await cli("upgrade")

			expect(errorLines.join("\n")).toContain("[CLI] Error: github unreachable")
			expect(exitCodes()).toContain(1)
		})

		it("stringifies a non-Error upgrade failure", async () => {
			handlers.upgrade.mockRejectedValueOnce({ nope: true })

			await cli("upgrade")

			expect(errorLines.join("\n")).toContain("[CLI] Error: [object Object]")
			expect(exitCodes()).toContain(1)
		})
	})

	describe("serve", () => {
		it("defaults every serve flag", async () => {
			await cli("serve")

			expect(handlers.serve).toHaveBeenCalledTimes(1)
			expect(handlers.serve.mock.calls[0]![0]).toMatchObject({
				quiet: false,
				debug: false,
				interactive: false,
			})
		})

		it("carries the serve flags through", async () => {
			await cli(
				"serve",
				"-p",
				"31000",
				"--host",
				"0.0.0.0",
				"-w",
				"/tmp",
				"-e",
				"/ext",
				"-k",
				"sk-test",
				"--provider",
				"shofer",
				"--base-url",
				"http://localhost:30081/v1",
				"-m",
				"a/b",
				"-t",
				"tok",
				"--state-dir",
				"/tmp/state",
				"-q",
				"-d",
				"--interactive",
			)

			expect(handlers.serve.mock.calls[0]![0]).toEqual({
				port: "31000",
				host: "0.0.0.0",
				workspace: "/tmp",
				extension: "/ext",
				apiKey: "sk-test",
				provider: "shofer",
				baseUrl: "http://localhost:30081/v1",
				model: "a/b",
				token: "tok",
				stateDir: "/tmp/state",
				quiet: true,
				debug: true,
				interactive: true,
			})
		})
	})

	describe("acp", () => {
		it("carries the acp flags through", async () => {
			await cli("acp", "-w", "/tmp", "-e", "/ext", "-k", "sk-test", "--provider", "shofer", "-m", "a/b", "-d")

			expect(handlers.acp.mock.calls[0]![0]).toEqual({
				workspace: "/tmp",
				extension: "/ext",
				apiKey: "sk-test",
				provider: "shofer",
				model: "a/b",
				debug: true,
			})
		})
	})

	describe("plugin subcommands", () => {
		it("installs with the three install flags defaulted off", async () => {
			await cli("plugin", "install", "./my-plugin")

			expect(handlers.pluginInstall).toHaveBeenCalledWith("./my-plugin", {
				overwrite: false,
				enable: false,
				allowInsecureHttp: false,
			})
			expect(exitCodes()).toContain(0)
		})

		it("passes --overwrite, --enable and --allow-insecure-http", async () => {
			await cli(
				"plugin",
				"install",
				"http://host/p.shofer-plugin",
				"--overwrite",
				"--enable",
				"--allow-insecure-http",
			)

			expect(handlers.pluginInstall).toHaveBeenCalledWith("http://host/p.shofer-plugin", {
				overwrite: true,
				enable: true,
				allowInsecureHttp: true,
			})
		})

		it("lists plugins, with and without --json", async () => {
			await cli("plugin", "list")
			expect(handlers.pluginList).toHaveBeenCalledWith({ json: false })

			await cli("plugin", "list", "--json")
			expect(handlers.pluginList).toHaveBeenLastCalledWith({ json: true })
		})

		it("packs a plugin directory, with and without an explicit output file", async () => {
			await cli("plugin", "pack", "./my-plugin")
			expect(handlers.pluginPack).toHaveBeenCalledWith("./my-plugin", undefined)

			await cli("plugin", "pack", "./my-plugin", "out.shofer-plugin")
			expect(handlers.pluginPack).toHaveBeenLastCalledWith("./my-plugin", "out.shofer-plugin")
		})

		it("removes a plugin by name", async () => {
			await cli("plugin", "remove", "alpha")
			expect(handlers.pluginRemove).toHaveBeenCalledWith("alpha")
		})

		it("reports a failing plugin command and exits 1", async () => {
			handlers.pluginRemove.mockRejectedValueOnce(new Error('No plugin named "ghost" is installed'))

			await cli("plugin", "remove", "ghost")

			expect(errorLines.join("\n")).toContain('[CLI] Error: No plugin named "ghost" is installed')
			expect(exitCodes()).toContain(1)
		})

		it("stringifies a non-Error plugin failure", async () => {
			handlers.pluginList.mockRejectedValueOnce("boom")

			await cli("plugin", "list")

			expect(errorLines.join("\n")).toContain("[CLI] Error: boom")
			expect(exitCodes()).toContain(1)
		})
	})
})
