/**
 * Unit tests for `shofer acp` (`src/commands/cli/acp.ts`) and the
 * `commands/cli` / `commands` barrels.
 *
 * ACP carries no permission channel, so the interesting assertion is that the
 * host is built non-interactive WITH the unattended approval seed — an ask
 * raised on this path could only hang. The extension host is faked; stdin and
 * stdout are handed over but never read or written because `runAcp` is a stub.
 */

import { acp } from "../acp.js"

const hostState = vi.hoisted(() => ({ instances: [] as Array<Record<string, unknown>> }))

vi.mock("@/agent/index.js", () => {
	class ExtensionHost {
		options: unknown
		activate = vi.fn(async () => {})
		runAcp = vi.fn(async () => {})

		constructor(options: unknown) {
			this.options = options
			hostState.instances.push(this as unknown as Record<string, unknown>)
		}
	}

	return { ExtensionHost, unattendedApprovalSeed: () => ({ unattended: true }) }
})

function lastHost(): Record<string, unknown> {
	return hostState.instances.at(-1)!
}

describe("acp", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		hostState.instances = []
	})

	it("defaults to openrouter, the cwd and the bundled extension path", async () => {
		await acp()

		expect(lastHost().options).toMatchObject({
			mode: "code",
			provider: "openrouter",
			workspacePath: process.cwd(),
			nonInteractive: true,
			ephemeral: false,
			debug: false,
			exitOnComplete: false,
			exitOnError: false,
			disableOutput: true,
		})
		expect((lastHost().options as { model?: string }).model).toBeTruthy()
	})

	it("seeds unattended approvals because ACP has no permission channel", async () => {
		await acp()
		expect(lastHost().options).toMatchObject({ approvalSeed: { unattended: true } })
	})

	it("honours the provider, model, key, workspace, extension and debug flags", async () => {
		await acp({
			provider: "shofer",
			model: "arkware/x",
			apiKey: "sk-test",
			workspace: ".",
			extension: "/tmp",
			debug: true,
		})

		expect(lastHost().options).toMatchObject({
			provider: "shofer",
			model: "arkware/x",
			apiKey: "sk-test",
			workspacePath: process.cwd(),
			extensionPath: "/tmp",
			debug: true,
		})
	})

	it("activates the host and hands stdio to the ACP server", async () => {
		await acp()

		expect(lastHost().activate).toHaveBeenCalledTimes(1)
		expect(lastHost().runAcp).toHaveBeenCalledWith({ input: process.stdin, output: process.stdout })
	})
})

describe("command barrels", () => {
	it("re-export every CLI verb the program wires", async () => {
		const cli = await import("../index.js")

		for (const name of [
			"run",
			"listCommands",
			"listModes",
			"listModels",
			"listSessions",
			"upgrade",
			"acp",
			"serve",
		]) {
			expect(typeof (cli as unknown as Record<string, unknown>)[name]).toBe("function")
		}
	})

	it("re-export the auth, cli and plugin verbs from the top-level barrel", async () => {
		const commands = await import("@/commands/index.js")

		for (const name of [
			"login",
			"logout",
			"status",
			"run",
			"upgrade",
			"pluginInstall",
			"pluginList",
			"pluginPack",
			"pluginRemove",
		]) {
			expect(typeof (commands as unknown as Record<string, unknown>)[name]).toBe("function")
		}
	})
})
