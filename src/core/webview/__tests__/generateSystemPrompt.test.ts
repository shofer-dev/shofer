// npx vitest src/core/webview/__tests__/generateSystemPrompt.test.ts

/**
 * The Settings "preview the system prompt" path. Its whole job is to assemble
 * the SAME arguments the real turn would, so what it shows is what the model
 * would see — including the section toggles a deployment's configuration scope
 * may have gated off and the conversational (tool-free) variant. It builds a
 * THROWAWAY api handler purely to read model info, and a failure there must
 * degrade to "no model info" rather than aborting the preview.
 */

const hoisted = vi.hoisted(() => ({
	systemPrompt: vi.fn(async (...args: unknown[]): Promise<string> => `ASSEMBLED PROMPT${args.length ? "" : ""}`),
	buildApiHandler: vi.fn((..._args: unknown[]): { getModel: () => { info: Record<string, unknown> } } => ({
		getModel: () => ({ info: { isStealthModel: true } }),
	})),
	configGet: vi.fn((_section: string, _key: string, def: unknown) => def),
	logs: [] as unknown[],
}))

vi.mock("vscode", () => ({}))

vi.mock("@shofer/types", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/types")>()),
	getHost: () => ({ config: { get: hoisted.configGet } }),
}))

vi.mock("@shofer/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@shofer/core")>()),
	SYSTEM_PROMPT: hoisted.systemPrompt,
	buildApiHandler: hoisted.buildApiHandler,
	webviewLog: { error: (...a: unknown[]) => hoisted.logs.push(a), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { generateSystemPrompt } from "../generateSystemPrompt"
import type { ShoferProvider } from "../ShoferProvider"

function makeProvider(state: Record<string, unknown> = {}, task?: Record<string, unknown>) {
	return {
		cwd: "/workspace",
		context: { extensionPath: "/ext" },
		getState: vi.fn(async () => ({ apiConfiguration: { apiProvider: "anthropic" }, ...state })),
		customModesManager: { getCustomModes: vi.fn(async () => [{ slug: "custom" }]) },
		getCurrentTask: vi.fn(() => task),
		getMcpHub: vi.fn(() => ({ hub: true })),
		getSkillsManager: vi.fn(() => ({ skills: true })),
	} as unknown as ShoferProvider
}

/** The options bag `SYSTEM_PROMPT` was called with. */
function optionsArg() {
	return hoisted.systemPrompt.mock.calls[0][12] as Record<string, unknown>
}

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.logs = []
	hoisted.systemPrompt.mockResolvedValue("ASSEMBLED PROMPT")
	hoisted.buildApiHandler.mockReturnValue({ getModel: () => ({ info: { isStealthModel: true } }) })
	hoisted.configGet.mockImplementation((_s: string, _k: string, def: unknown) => def)
})

describe("generateSystemPrompt", () => {
	it("returns the assembled prompt", async () => {
		await expect(generateSystemPrompt(makeProvider(), { type: "getSystemPrompt" } as never)).resolves.toBe(
			"ASSEMBLED PROMPT",
		)
	})

	it("falls back to the DEFAULT mode when the message names none", async () => {
		await generateSystemPrompt(makeProvider(), { type: "getSystemPrompt" } as never)

		expect(hoisted.systemPrompt.mock.calls[0][5]).toBe("code")
	})

	it("uses the mode the message names", async () => {
		await generateSystemPrompt(makeProvider(), { type: "getSystemPrompt", mode: "architect" } as never)

		expect(hoisted.systemPrompt.mock.calls[0][5]).toBe("architect")
	})

	it("passes the MCP hub only when MCP is enabled", async () => {
		await generateSystemPrompt(makeProvider({ mcpEnabled: true }), { type: "getSystemPrompt" } as never)
		expect(hoisted.systemPrompt.mock.calls[0][3]).toEqual({ hub: true })

		hoisted.systemPrompt.mockClear()
		await generateSystemPrompt(makeProvider({ mcpEnabled: false }), { type: "getSystemPrompt" } as never)
		expect(hoisted.systemPrompt.mock.calls[0][3]).toBeUndefined()
	})

	it("carries the current task's shoferignore instructions", async () => {
		const task = { shoferIgnoreController: { getInstructions: () => "IGNORE RULES" } }

		await generateSystemPrompt(makeProvider({}, task), { type: "getSystemPrompt" } as never)

		expect(hoisted.systemPrompt.mock.calls[0][11]).toBe("IGNORE RULES")
	})

	it("passes undefined ignore instructions with no task", async () => {
		await generateSystemPrompt(makeProvider(), { type: "getSystemPrompt" } as never)

		expect(hoisted.systemPrompt.mock.calls[0][11]).toBeUndefined()
	})

	it("defaults the three tri-state flags to ON when state says nothing", async () => {
		await generateSystemPrompt(makeProvider(), { type: "getSystemPrompt" } as never)

		expect(optionsArg()).toMatchObject({ todoListEnabled: true, useAgentRules: true, enableSubfolderRules: true })
	})

	it("honours explicit FALSE for those flags", async () => {
		const provider = makeProvider({
			apiConfiguration: { todoListEnabled: false },
			useAgentRules: false,
			enableSubfolderRules: false,
		})

		await generateSystemPrompt(provider, { type: "getSystemPrompt" } as never)

		expect(optionsArg()).toMatchObject({
			todoListEnabled: false,
			useAgentRules: false,
			enableSubfolderRules: false,
		})
	})

	it("forwards every section toggle so a gated-off section is absent from the PREVIEW too", async () => {
		const provider = makeProvider({
			includeMarkdownFormattingSection: false,
			includeToolUseSection: false,
			includeCapabilitiesSection: true,
			includeModesSection: false,
			includeRulesSection: true,
			includeObjectiveSection: false,
		})

		await generateSystemPrompt(provider, { type: "getSystemPrompt" } as never)

		expect(optionsArg()).toMatchObject({
			includeMarkdownFormatting: false,
			includeToolUse: false,
			includeCapabilities: true,
			includeModes: false,
			includeRules: true,
			includeObjective: false,
		})
	})

	it("reads newTaskRequireTodos from the host config, defaulting to false", async () => {
		await generateSystemPrompt(makeProvider(), { type: "getSystemPrompt" } as never)
		expect(optionsArg().newTaskRequireTodos).toBe(false)

		hoisted.systemPrompt.mockClear()
		hoisted.configGet.mockImplementation(() => true)
		await generateSystemPrompt(makeProvider(), { type: "getSystemPrompt" } as never)
		expect(optionsArg().newTaskRequireTodos).toBe(true)
	})

	it("surfaces the model's stealth flag, read off a THROWAWAY handler", async () => {
		await generateSystemPrompt(makeProvider(), { type: "getSystemPrompt" } as never)

		expect(hoisted.buildApiHandler).toHaveBeenCalledWith({ apiProvider: "anthropic" })
		expect(optionsArg().isStealthModel).toBe(true)
	})

	it("DEGRADES rather than aborting when the throwaway handler cannot be built", async () => {
		hoisted.buildApiHandler.mockImplementationOnce(() => {
			throw new Error("no api key configured")
		})

		await expect(generateSystemPrompt(makeProvider(), { type: "getSystemPrompt" } as never)).resolves.toBe(
			"ASSEMBLED PROMPT",
		)
		expect(optionsArg().isStealthModel).toBeUndefined()
		expect(hoisted.logs).not.toHaveLength(0)
	})

	it("passes the skills manager, so the preview shows the skills the model would see", async () => {
		await generateSystemPrompt(makeProvider(), { type: "getSystemPrompt" } as never)

		expect(hoisted.systemPrompt.mock.calls[0][15]).toEqual({ skills: true })
	})

	it("declares no computer-use support — the browser tool set was removed", async () => {
		await generateSystemPrompt(makeProvider(), { type: "getSystemPrompt" } as never)

		expect(hoisted.systemPrompt.mock.calls[0][2]).toBe(false)
	})
})
