// npx vitest core/prompts/__tests__/system-prompt.spec.ts

vi.mock("os", () => ({
	default: {
		homedir: () => "/home/user",
		platform: () => "linux",
		arch: () => "x64",
		type: () => "Linux",
		release: () => "5.4.0",
		hostname: () => "test-host",
		tmpdir: () => "/tmp",
		endianness: () => "LE",
		loadavg: () => [0, 0, 0],
		totalmem: () => 8589934592,
		freemem: () => 4294967296,
		cpus: () => [],
		networkInterfaces: () => ({}),
		userInfo: () => ({ username: "test", uid: 1000, gid: 1000, shell: "/bin/bash", homedir: "/home/user" }),
	},
	homedir: () => "/home/user",
	platform: () => "linux",
	arch: () => "x64",
	type: () => "Linux",
	release: () => "5.4.0",
	hostname: () => "test-host",
	tmpdir: () => "/tmp",
	endianness: () => "LE",
	loadavg: () => [0, 0, 0],
	totalmem: () => 8589934592,
	freemem: () => 4294967296,
	cpus: () => [],
	networkInterfaces: () => ({}),
	userInfo: () => ({ username: "test", uid: 1000, gid: 1000, shell: "/bin/bash", homedir: "/home/user" }),
}))

vi.mock("default-shell", () => ({
	default: "/bin/zsh",
}))

vi.mock("os-name", () => ({
	default: () => "Linux",
}))

vi.mock("fs/promises")

import { setHost, createInMemoryHost, inMemoryEnv } from "@shofer/types"
import { ModeConfig } from "@shofer/types"

import { SYSTEM_PROMPT } from "../system.js"
import type { McpHub } from "../../services/mcp/McpHub.js"
import { defaultModeSlug, Mode } from "@shofer/types"

import { BUILTIN_MODES } from "../../__fixtures__/builtin-modes.js"

// Mock the sections
vi.mock("../sections/modes.js", () => ({
	getModesSection: vi.fn().mockImplementation(async () => `====\n\nMODES\n\n- Test modes section`),
}))

// Mock the custom instructions
vi.mock("../sections/custom-instructions.js", () => {
	const addCustomInstructions = vi.fn()
	return {
		addCustomInstructions,
		loadRuleFiles: vi.fn().mockResolvedValue(""),
		__setMockImplementation: (impl: any) => {
			addCustomInstructions.mockImplementation(impl)
		},
	}
})

// Set up default mock implementation
const customInstructionsMock = vi.mocked(await import("../sections/custom-instructions.js"))
const { __setMockImplementation } = customInstructionsMock as any
__setMockImplementation(
	async (
		modeCustomInstructions: string,
		globalCustomInstructions: string,
		cwd: string,
		mode: string,
		options?: { language?: string; shoferIgnoreInstructions?: string; settings?: Record<string, any> },
	) => {
		const sections = []

		// Add language preference if provided
		if (options?.language) {
			sections.push(
				`Language Preference:\nYou should always speak and think in the "${options.language}" language.`,
			)
		}

		// Add global instructions first
		if (globalCustomInstructions?.trim()) {
			sections.push(`Global Instructions:\n${globalCustomInstructions.trim()}`)
		}

		// Add mode-specific instructions after
		if (modeCustomInstructions?.trim()) {
			sections.push(`Mode-specific Instructions:\n${modeCustomInstructions}`)
		}

		// Add rules
		const rules = []
		if (mode) {
			rules.push(`# Rules from .clinerules-${mode}:\nMock mode-specific rules`)
		}
		rules.push(`# Rules from .clinerules:\nMock generic rules`)

		if (rules.length > 0) {
			sections.push(`Rules:\n${rules.join("\n")}`)
		}

		const joinedSections = sections.join("\n\n")
		const toolUseRef = "."
		return joinedSections
			? `\n====\n\nUSER'S CUSTOM INSTRUCTIONS\n\nThe following additional instructions are provided by the user, and should be followed to the best of your ability${toolUseRef}\n\n${joinedSections}`
			: ""
	},
)

// The shell is read through core's `utils/shell`; pin it so system-info / rules
// stay deterministic across platforms.
vi.mock("../../utils/shell.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../utils/shell.js")>()),
	getShell: () => "/bin/zsh",
}))

// A minimal opaque provider context — the core only checks it for truthiness and,
// with the in-memory host, never resolves a code-index manager from it.
const mockContext = {
	extensionPath: "/mock/extension/path",
	globalStoragePath: "/mock/storage/path",
	storagePath: "/mock/storage/path",
	logPath: "/mock/log/path",
	subscriptions: [],
	globalState: {
		get: () => undefined,
		update: () => Promise.resolve(),
		setKeysForSync: () => {},
	},
} as unknown

// Instead of extending McpHub, create a mock that implements just what we need
const createMockMcpHub = (withServers: boolean = false): McpHub =>
	({
		getServers: () =>
			withServers
				? [
						{
							name: "test-server",
							disabled: false,
							resources: [{ uri: "test://resource", name: "Test Resource" }],
						},
					]
				: [],
		getMcpServersPath: async () => "/mock/mcp/path",
		getMcpSettingsFilePath: async () => "/mock/settings/path",
		dispose: async () => {},
		// Add other required public methods with no-op implementations
		restartConnection: async () => {},
		readResource: async () => ({ contents: [] }),
		callTool: async () => ({ content: [] }),
		toggleServerDisabled: async () => {},
		isConnecting: false,
		connections: [],
	}) as unknown as McpHub

describe("SYSTEM_PROMPT", () => {
	let mockMcpHub: McpHub
	let experiments: Record<string, boolean> | undefined

	beforeEach(() => {
		// Reset experiments before each test to ensure they're disabled by default.
		experiments = {}
	})

	beforeEach(() => {
		vi.clearAllMocks()
		setHost(createInMemoryHost())
	})

	afterEach(async () => {
		if (mockMcpHub) {
			await mockMcpHub.dispose()
		}
	})

	it("should maintain consistent system prompt", async () => {
		const prompt = await SYSTEM_PROMPT(
			mockContext,
			"/test/path",
			false, // supportsImages
			undefined, // mcpHub
			undefined, // diffStrategy
			defaultModeSlug, // mode
			undefined, // customModePrompts
			BUILTIN_MODES, // customModes
			undefined, // globalCustomInstructions
			experiments,
			undefined, // language
			undefined, // shoferIgnoreInstructions
		)

		expect(prompt).toMatchFileSnapshot("./__snapshots__/system-prompt/consistent-system-prompt.snap")
	})

	it("should include MCP server info when mcpHub is provided", async () => {
		mockMcpHub = createMockMcpHub(true)

		const prompt = await SYSTEM_PROMPT(
			mockContext,
			"/test/path",
			false,
			mockMcpHub, // mcpHub
			undefined, // diffStrategy
			defaultModeSlug, // mode
			undefined, // customModePrompts
			BUILTIN_MODES, // customModes,
			undefined, // globalCustomInstructions
			experiments,
			undefined, // language
			undefined, // shoferIgnoreInstructions
		)

		expect(prompt).toMatchFileSnapshot("./__snapshots__/system-prompt/with-mcp-hub-provided.snap")
	})

	it("should explicitly handle undefined mcpHub", async () => {
		const prompt = await SYSTEM_PROMPT(
			mockContext,
			"/test/path",
			false,
			undefined, // explicitly undefined mcpHub
			undefined, // diffStrategy
			defaultModeSlug, // mode
			undefined, // customModePrompts
			BUILTIN_MODES, // customModes,
			undefined, // globalCustomInstructions
			experiments,
			undefined, // language
			undefined, // shoferIgnoreInstructions
		)

		expect(prompt).toMatchFileSnapshot("./__snapshots__/system-prompt/with-undefined-mcp-hub.snap")
	})

	it("should include vscode language in custom instructions", async () => {
		// Drive the host UI language to Spanish for this case.
		setHost({ ...createInMemoryHost(), env: { ...inMemoryEnv, language: "es" } })

		const prompt = await SYSTEM_PROMPT(
			mockContext,
			"/test/path",
			false,
			undefined, // mcpHub
			undefined, // diffStrategy
			defaultModeSlug, // mode
			undefined, // customModePrompts
			BUILTIN_MODES, // customModes
			undefined, // globalCustomInstructions
			undefined, // experiments
			undefined, // language
			undefined, // shoferIgnoreInstructions
		)

		expect(prompt).toContain("Language Preference:")
		expect(prompt).toContain('You should always speak and think in the "es" language')
	})

	it("should include custom mode role definition at top and instructions at bottom", async () => {
		const modeCustomInstructions = "Custom mode instructions"

		const customModes: ModeConfig[] = [
			{
				slug: "custom-mode",
				name: "Custom Mode",
				roleDefinition: "Custom role definition",
				customInstructions: modeCustomInstructions,
				tools: ["read"] as const,
			},
		]

		const prompt = await SYSTEM_PROMPT(
			mockContext,
			"/test/path",
			false,
			undefined, // mcpHub
			undefined, // diffStrategy
			"custom-mode", // mode
			undefined, // customModePrompts
			[...customModes, ...BUILTIN_MODES], // customModes
			"Global instructions", // globalCustomInstructions
			experiments,
			undefined, // language
			undefined, // shoferIgnoreInstructions
		)

		// Role definition should be at the top
		expect(prompt.indexOf("Custom role definition")).toBeLessThan(prompt.indexOf("TOOL USE"))

		// Custom instructions should be at the bottom
		const customInstructionsIndex = prompt.indexOf("Custom mode instructions")
		const userInstructionsHeader = prompt.indexOf("USER'S CUSTOM INSTRUCTIONS")
		expect(customInstructionsIndex).toBeGreaterThan(-1)
		expect(userInstructionsHeader).toBeGreaterThan(-1)
		expect(customInstructionsIndex).toBeGreaterThan(userInstructionsHeader)
	})

	it("should use promptComponent roleDefinition when available", async () => {
		const customModePrompts = {
			[defaultModeSlug]: {
				roleDefinition: "Custom prompt role definition",
				customInstructions: "Custom prompt instructions",
			},
		}

		const prompt = await SYSTEM_PROMPT(
			mockContext,
			"/test/path",
			false,
			undefined, // mcpHub
			undefined, // diffStrategy
			defaultModeSlug as Mode, // mode
			customModePrompts, // customModePrompts
			BUILTIN_MODES, // customModes
			undefined, // globalCustomInstructions
			undefined, // experiments
			undefined, // language
			undefined, // shoferIgnoreInstructions
		)

		// Role definition from promptComponent should be at the top
		expect(prompt.indexOf("Custom prompt role definition")).toBeLessThan(prompt.indexOf("TOOL USE"))
		// Should not contain the default mode's role definition
		expect(prompt).not.toContain(BUILTIN_MODES[0]!.roleDefinition)
	})

	it("should fallback to modeConfig roleDefinition when promptComponent has no roleDefinition", async () => {
		const customModePrompts = {
			[defaultModeSlug]: {
				customInstructions: "Custom prompt instructions",
				// No roleDefinition provided
			},
		}

		const prompt = await SYSTEM_PROMPT(
			mockContext,
			"/test/path",
			false,
			undefined, // mcpHub
			undefined, // diffStrategy
			defaultModeSlug as Mode, // mode
			customModePrompts, // customModePrompts
			BUILTIN_MODES, // customModes
			undefined, // globalCustomInstructions
			undefined, // experiments
			undefined, // language
			undefined, // shoferIgnoreInstructions
		)

		// Should use the default mode's role definition
		expect(prompt.indexOf(BUILTIN_MODES[0]!.roleDefinition)).toBeLessThan(prompt.indexOf("TOOL USE"))
	})

	it("should exclude update_todo_list tool when todoListEnabled is false", async () => {
		const settings = {
			todoListEnabled: false,
			useAgentRules: true,
			newTaskRequireTodos: false,
		}

		const prompt = await SYSTEM_PROMPT(
			mockContext,
			"/test/path",
			false,
			undefined, // mcpHub
			undefined, // diffStrategy
			defaultModeSlug, // mode
			undefined, // customModePrompts
			BUILTIN_MODES, // customModes
			undefined, // globalCustomInstructions
			experiments,
			undefined, // language
			undefined, // shoferIgnoreInstructions
			settings, // settings
		)

		// Should not contain the tool description
		expect(prompt).not.toContain("## update_todo_list")
		// Mode instructions will still reference the tool with a fallback to markdown
	})

	it("should include update_todo_list tool when todoListEnabled is true", async () => {
		const settings = {
			todoListEnabled: true,
			useAgentRules: true,
			newTaskRequireTodos: false,
		}

		const prompt = await SYSTEM_PROMPT(
			mockContext,
			"/test/path",
			false,
			undefined, // mcpHub
			undefined, // diffStrategy
			defaultModeSlug, // mode
			undefined, // customModePrompts
			BUILTIN_MODES, // customModes
			undefined, // globalCustomInstructions
			experiments,
			undefined, // language
			undefined, // shoferIgnoreInstructions
			settings, // settings
		)

		// Tool catalogs are no longer embedded in the system prompt.
		expect(prompt).not.toContain("## update_todo_list")
	})

	it("should include update_todo_list tool when todoListEnabled is undefined", async () => {
		const settings = {
			todoListEnabled: true,
			useAgentRules: true,
			newTaskRequireTodos: false,
		}

		const prompt = await SYSTEM_PROMPT(
			mockContext,
			"/test/path",
			false,
			undefined, // mcpHub
			undefined, // diffStrategy
			defaultModeSlug, // mode
			undefined, // customModePrompts
			BUILTIN_MODES, // customModes
			undefined, // globalCustomInstructions
			experiments,
			undefined, // language
			undefined, // shoferIgnoreInstructions
			settings, // settings
		)

		// Tool catalogs are no longer embedded in the system prompt.
		expect(prompt).not.toContain("## update_todo_list")
	})

	it("should include native tool instructions", async () => {
		const settings = {
			todoListEnabled: true,
			useAgentRules: true,
			newTaskRequireTodos: false,
		}

		const prompt = await SYSTEM_PROMPT(
			mockContext,
			"/test/path",
			false,
			undefined, // mcpHub
			undefined, // diffStrategy
			defaultModeSlug, // mode
			undefined, // customModePrompts
			BUILTIN_MODES, // customModes
			undefined, // globalCustomInstructions
			experiments,
			undefined, // language
			undefined, // shoferIgnoreInstructions
			settings, // settings
		)

		// Should contain TOOL USE section with native note
		expect(prompt).toContain("TOOL USE")
		expect(prompt).toContain("provider-native tool-calling mechanism")
		expect(prompt).toContain("Do not include XML markup or examples")

		// Should NOT contain XML-style tags or examples
		expect(prompt).not.toContain("<actual_tool_name>")
		expect(prompt).not.toContain("</actual_tool_name>")

		// Should contain Tool Use Guidelines section
		expect(prompt).toContain("Tool Use Guidelines")

		// Should NOT contain a tool catalog / XML examples
		expect(prompt).not.toContain("# Tools")
		expect(prompt).not.toContain("## read_file")
		expect(prompt).not.toContain("## execute_command")
		expect(prompt).not.toContain("<read_file>")
		expect(prompt).not.toContain("<path>")
		expect(prompt).not.toContain("Usage:")
		expect(prompt).not.toContain("Examples:")

		// Should still contain role definition and other non-XML sections
		expect(prompt).toContain(BUILTIN_MODES[0]!.roleDefinition)
		expect(prompt).toContain("CAPABILITIES")
		expect(prompt).toContain("RULES")
		expect(prompt).toContain("SYSTEM INFORMATION")
		expect(prompt).toContain("OBJECTIVE")
	})

	afterAll(() => {
		vi.restoreAllMocks()
	})
})
