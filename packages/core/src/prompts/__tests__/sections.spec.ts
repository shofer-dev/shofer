import { addCustomInstructions } from "../sections/custom-instructions.js"
import { getRulesSection, getCommandChainOperator } from "../sections/rules.js"
import { getCapabilitiesSection } from "../sections/capabilities.js"
import type { McpHub } from "../../services/mcp/McpHub.js"
import * as shellUtils from "../../utils/shell.js"

// `getShell` lives in core's `utils/shell`; mock it there so each test can drive
// the returned shell path (previously done via vi.spyOn on the src utils/shell module).
vi.mock("../../utils/shell.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../utils/shell.js")>()),
	// Default to a real-ish shell so tests that don't drive getShell explicitly
	// (e.g. the vendor-confidentiality cases) still get a usable value.
	getShell: vi.fn(() => "/bin/bash"),
}))

describe("addCustomInstructions", () => {
	it("adds vscode language to custom instructions", async () => {
		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/test/path",
			"test-mode",
			{ language: "fr" },
		)

		expect(result).toContain("Language Preference:")
		expect(result).toContain('You should always speak and think in the "Français" (fr) language')
	})

	it("works without vscode language", async () => {
		const result = await addCustomInstructions(
			"mode instructions",
			"global instructions",
			"/test/path",
			"test-mode",
		)

		expect(result).not.toContain("Language Preference:")
		expect(result).not.toContain("You should always speak and think in")
	})
})

describe("getCapabilitiesSection", () => {
	const cwd = "/test/path"

	it("includes standard capabilities", () => {
		const result = getCapabilitiesSection(cwd)

		expect(result).toContain("CAPABILITIES")
		expect(result).toContain("execute CLI commands")
		expect(result).toContain("list files")
		expect(result).toContain("read and write files")
	})

	it("includes MCP reference when mcpHub is provided", () => {
		const mockMcpHub = {} as McpHub
		const result = getCapabilitiesSection(cwd, mockMcpHub)

		expect(result).toContain("MCP servers")
	})

	it("excludes MCP reference when mcpHub is undefined", () => {
		const result = getCapabilitiesSection(cwd, undefined)

		expect(result).not.toContain("MCP servers")
	})

	// The section describes the tool INVENTORY, so it must change when most of
	// that inventory arrives as stubs — otherwise the model reads one-line
	// entries as a smaller set of capabilities than it actually has.
	it("says the stub list IS the inventory when the mode tiers its schemas", () => {
		const withMcp = getCapabilitiesSection(cwd, {} as McpHub, undefined, true)
		const withoutMcp = getCapabilitiesSection(cwd, undefined, undefined, true)
		const restricted = getCapabilitiesSection(cwd, undefined, new Set(["read"]), true)

		for (const result of [withMcp, withoutMcp, restricted]) {
			expect(result).toContain("describe_tools")
			expect(result).toContain("not as a summary of it")
		}
	})

	it("is byte-identical to the untiered section when the mode does not tier", () => {
		expect(getCapabilitiesSection(cwd, {} as McpHub, undefined, false)).toEqual(
			getCapabilitiesSection(cwd, {} as McpHub),
		)
		expect(getCapabilitiesSection(cwd, undefined, new Set(["read"]), false)).toEqual(
			getCapabilitiesSection(cwd, undefined, new Set(["read"])),
		)
	})
})

describe("getRulesSection", () => {
	const cwd = "/test/path"

	it("includes standard rules", () => {
		const result = getRulesSection(cwd)

		expect(result).toContain("RULES")
		expect(result).toContain("project base directory")
		expect(result).toContain(cwd)
	})

	it("includes vendor confidentiality section when isStealthModel is true", () => {
		const settings = {
			todoListEnabled: true,
			useAgentRules: true,
			newTaskRequireTodos: false,
			isStealthModel: true,
		}

		const result = getRulesSection(cwd, settings)

		expect(result).toContain("VENDOR CONFIDENTIALITY")
		expect(result).toContain("Never reveal the vendor or company that created you")
		expect(result).toContain("I was created by a team of developers")
		expect(result).toContain("I'm an open-source project maintained by contributors")
		expect(result).toContain("I don't have information about specific vendors")
	})

	it("excludes vendor confidentiality section when isStealthModel is false", () => {
		const settings = {
			todoListEnabled: true,
			useAgentRules: true,
			newTaskRequireTodos: false,
			isStealthModel: false,
		}

		const result = getRulesSection(cwd, settings)

		expect(result).not.toContain("VENDOR CONFIDENTIALITY")
		expect(result).not.toContain("Never reveal the vendor or company")
	})

	it("excludes vendor confidentiality section when isStealthModel is undefined", () => {
		const settings = {
			todoListEnabled: true,
			useAgentRules: true,
			newTaskRequireTodos: false,
		}

		const result = getRulesSection(cwd, settings)

		expect(result).not.toContain("VENDOR CONFIDENTIALITY")
		expect(result).not.toContain("Never reveal the vendor or company")
	})
})

describe("getCommandChainOperator", () => {
	it("returns && for bash shell", () => {
		vi.mocked(shellUtils.getShell).mockReturnValue("/bin/bash")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns && for zsh shell", () => {
		vi.mocked(shellUtils.getShell).mockReturnValue("/bin/zsh")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns ; for PowerShell", () => {
		vi.mocked(shellUtils.getShell).mockReturnValue("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
		expect(getCommandChainOperator()).toBe(";")
	})

	it("returns ; for PowerShell Core (pwsh)", () => {
		vi.mocked(shellUtils.getShell).mockReturnValue("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
		expect(getCommandChainOperator()).toBe(";")
	})

	it("returns && for cmd.exe", () => {
		vi.mocked(shellUtils.getShell).mockReturnValue("C:\\Windows\\System32\\cmd.exe")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns && for Git Bash on Windows", () => {
		vi.mocked(shellUtils.getShell).mockReturnValue("C:\\Program Files\\Git\\bin\\bash.exe")
		expect(getCommandChainOperator()).toBe("&&")
	})

	it("returns && for WSL bash", () => {
		vi.mocked(shellUtils.getShell).mockReturnValue("/bin/bash")
		expect(getCommandChainOperator()).toBe("&&")
	})
})

describe("getRulesSection shell-aware command chaining", () => {
	const cwd = "/test/path"

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("uses && for Unix shells in command chaining example", () => {
		vi.mocked(shellUtils.getShell).mockReturnValue("/bin/bash")
		const result = getRulesSection(cwd)

		expect(result).toContain("cd (path to project) && (command")
		expect(result).not.toContain("cd (path to project) ; (command")
		expect(result).not.toContain("cd (path to project) & (command")
	})

	it("uses ; for PowerShell in command chaining example", () => {
		vi.mocked(shellUtils.getShell).mockReturnValue("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
		const result = getRulesSection(cwd)

		expect(result).toContain("cd (path to project) ; (command")
		expect(result).toContain("Note: Using `;` for PowerShell command chaining")
	})

	it("uses && for cmd.exe in command chaining example", () => {
		vi.mocked(shellUtils.getShell).mockReturnValue("C:\\Windows\\System32\\cmd.exe")
		const result = getRulesSection(cwd)

		expect(result).toContain("cd (path to project) && (command")
		expect(result).toContain("Note: Using `&&` for cmd.exe command chaining")
	})

	it("includes Unix utility guidance for PowerShell", () => {
		vi.mocked(shellUtils.getShell).mockReturnValue("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
		const result = getRulesSection(cwd)

		expect(result).toContain("IMPORTANT: When using PowerShell, avoid Unix-specific utilities")
		expect(result).toContain("`sed`, `grep`, `awk`, `cat`, `rm`, `cp`, `mv`")
		expect(result).toContain("`Select-String` for grep")
		expect(result).toContain("`Get-Content` for cat")
		expect(result).toContain("PowerShell's `-replace` operator")
	})

	it("includes Unix utility guidance for cmd.exe", () => {
		vi.mocked(shellUtils.getShell).mockReturnValue("C:\\Windows\\System32\\cmd.exe")
		const result = getRulesSection(cwd)

		expect(result).toContain("IMPORTANT: When using cmd.exe, avoid Unix-specific utilities")
		expect(result).toContain("`sed`, `grep`, `awk`, `cat`, `rm`, `cp`, `mv`")
		expect(result).toContain("`type` for cat")
		expect(result).toContain("`del` for rm")
		expect(result).toContain("`find`/`findstr` for grep")
	})

	it("does not include Unix utility guidance for Unix shells", () => {
		vi.mocked(shellUtils.getShell).mockReturnValue("/bin/bash")
		const result = getRulesSection(cwd)

		expect(result).not.toContain("IMPORTANT: When using PowerShell")
		expect(result).not.toContain("IMPORTANT: When using cmd.exe")
		expect(result).not.toContain("`Select-String` for grep")
	})

	it("does not include note for Unix shells", () => {
		vi.mocked(shellUtils.getShell).mockReturnValue("/bin/zsh")
		const result = getRulesSection(cwd)

		expect(result).not.toContain("Note: Using")
	})
})
