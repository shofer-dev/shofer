import type { ModeConfig } from "@shofer/types"
import { FileRestrictionError } from "@shofer/types"

import { isToolAllowedForMode, isValidToolName, validateToolUse } from "../validateToolUse.js"

/**
 * Mode-scoped tool authorization — the second half of the Mode-Filtered Tool
 * Exposure Rule. `filterNativeToolsForMode` decides what the model is OFFERED;
 * this decides what it may actually CALL, and the two must agree.
 *
 * Three properties here are easy to break and silent when broken:
 *
 *  - a DYNAMIC group name (one no builtin defines) contributes no native tools,
 *    so it must be the empty set rather than a `TOOL_GROUPS[name]` TypeError —
 *    the Tool Group Count Coherence Rule's "never index TOOL_GROUPS by a name
 *    that came from config";
 *  - `fileRegex` enforcement is gated on a MUTATION param having arrived, and
 *    presence is tested with `!== undefined` rather than truthiness, so
 *    `content: ""` (clearing a file) is still enforced;
 *  - a user-disabled tool is refused ahead of everything, including the
 *    always-available set.
 */

const ARCHITECT: ModeConfig = {
	slug: "architect",
	name: "Architect",
	roleDefinition: "plans",
	groups: [],
	tools: ["read", ["write", { fileRegex: "\\.md$", description: "Markdown only" }]],
} as never

const READONLY: ModeConfig = {
	slug: "readonly",
	name: "Read Only",
	roleDefinition: "reads",
	groups: [],
	tools: ["read"],
} as never

const MODES = [ARCHITECT, READONLY]

describe("isValidToolName", () => {
	it("accepts a native tool, an MCP-prefixed tool and rejects an invention", () => {
		expect(isValidToolName("read_file")).toBe(true)
		expect(isValidToolName("mcp_myserver_do_thing")).toBe(true)
		expect(isValidToolName("teleport")).toBe(false)
	})
})

describe("validateToolUse", () => {
	it("names the tool and lists the real ones when the model invents a tool", () => {
		expect(() => validateToolUse("teleport" as never, "architect" as never, MODES)).toThrow(
			/Unknown tool "teleport"/,
		)
	})

	it("tells the model a disabled tool will never work, rather than blaming the mode", () => {
		expect(() =>
			validateToolUse("execute_command", "architect" as never, MODES, { execute_command: false }),
		).toThrow(/disabled by the user in Settings → Tools/)
	})

	it("refuses a disabled tool named by its ALIAS as well as its canonical name", () => {
		// `search_and_replace` resolves to `edit`; disabling either must refuse both.
		expect(() => validateToolUse("search_and_replace", "architect" as never, MODES, { edit: false })).toThrow(
			/disabled by the user/,
		)
	})

	it("reports a mode refusal separately from a disablement", () => {
		expect(() => validateToolUse("execute_command", "readonly" as never, MODES)).toThrow(
			'Tool "execute_command" is not allowed in readonly mode.',
		)
	})

	it("allows a tool the mode's groups carry", () => {
		expect(() => validateToolUse("read_file", "readonly" as never, MODES)).not.toThrow()
	})
})

describe("isToolAllowedForMode — group resolution", () => {
	it("admits an always-available tool in any mode", () => {
		expect(isToolAllowedForMode("attempt_completion", "readonly", MODES)).toBe(true)
	})

	it("refuses an always-available tool the user disabled", () => {
		expect(isToolAllowedForMode("attempt_completion", "readonly", MODES, { attempt_completion: false })).toBe(false)
	})

	it("refuses everything when tool requirements are the boolean false", () => {
		expect(isToolAllowedForMode("read_file", "readonly", MODES, false as never)).toBe(false)
	})

	it("refuses a tool for a mode that does not exist", () => {
		expect(isToolAllowedForMode("read_file", "no-such-mode", MODES)).toBe(false)
	})

	it("treats a DYNAMIC group name as the empty set instead of throwing", () => {
		const salesforceMode = {
			slug: "sf",
			name: "SF",
			roleDefinition: "",
			groups: [],
			tools: ["salesforce"],
		} as never as ModeConfig

		expect(() => isToolAllowedForMode("read_file", "sf", [salesforceMode])).not.toThrow()
		expect(isToolAllowedForMode("read_file", "sf", [salesforceMode])).toBe(false)
	})

	it("admits a dynamic MCP tool when the mode carries the mcp group", () => {
		const mcpMode = { slug: "m", name: "M", roleDefinition: "", groups: [], tools: ["mcp"] } as never as ModeConfig

		expect(isToolAllowedForMode("mcp_srv_do", "m", [mcpMode])).toBe(true)
		expect(isToolAllowedForMode("mcp_srv_do", "readonly", MODES)).toBe(false)
	})

	it("honours an explicit allow list and lets a deny list beat it", () => {
		const scoped = {
			slug: "s",
			name: "S",
			roleDefinition: "",
			groups: [],
			tools: [],
			tools_allowed: ["execute_command"],
			tools_denied: ["read_file"],
		} as never as ModeConfig

		expect(isToolAllowedForMode("execute_command", "s", [scoped])).toBe(true)
		expect(isToolAllowedForMode("read_file", "s", [scoped])).toBe(false)
	})

	it("applies a group-level allowed/denied scope", () => {
		const denied = {
			slug: "d",
			name: "D",
			roleDefinition: "",
			groups: [],
			tools: [{ read: { denied: ["read_file"] } }],
		} as never as ModeConfig
		const allowed = {
			slug: "a",
			name: "A",
			roleDefinition: "",
			groups: [],
			tools: [{ read: { allowed: ["list_files"] } }],
		} as never as ModeConfig

		expect(isToolAllowedForMode("read_file", "d", [denied])).toBe(false)
		expect(isToolAllowedForMode("list_files", "a", [allowed])).toBe(true)
		expect(isToolAllowedForMode("read_file", "a", [allowed])).toBe(false)
	})
})

describe("isToolAllowedForMode — fileRegex enforcement", () => {
	const call = (tool: string, params: Record<string, unknown>) =>
		isToolAllowedForMode(tool, "architect", MODES, undefined, params)

	it("permits a write whose target matches the mode's regex", () => {
		expect(call("write_to_file", { path: "docs/DESIGN.md", content: "x" })).toBe(true)
	})

	it("refuses a write outside the regex with a FileRestrictionError naming the pattern", () => {
		try {
			call("write_to_file", { path: "src/a.ts", content: "x" })
			expect.unreachable("expected a FileRestrictionError")
		} catch (error) {
			expect(error).toBeInstanceOf(FileRestrictionError)
			expect((error as Error).message).toContain("\\.md$")
			expect((error as Error).message).toContain("src/a.ts")
		}
	})

	it("does not enforce before the mutation parameter has streamed", () => {
		// Only `path` so far — rejecting here would fail a call the model has not
		// finished making.
		expect(call("write_to_file", { path: "src/a.ts" })).toBe(true)
	})

	it("enforces an EMPTY mutation value, which is a real mutation", () => {
		// Truthiness would read `content: ""` as absent and silently skip the gate.
		expect(() => call("write_to_file", { path: "src/a.ts", content: "" })).toThrow(FileRestrictionError)
	})

	it("enforces against BOTH endpoints of a move", () => {
		expect(call("file", { subcommand: "mv", path: "a.md", destination: "b.md" })).toBe(true)
		expect(() => call("file", { subcommand: "mv", path: "a.md", destination: "b.ts" })).toThrow(
			FileRestrictionError,
		)
	})

	it("enforces against the paths named INSIDE an apply_patch payload", () => {
		// `apply_patch` is an OPT-IN custom tool of the write group, so it only
		// reaches the fileRegex gate when the model's `includedTools` carries it.
		const patchCall = (patch: string) =>
			isToolAllowedForMode("apply_patch", "architect", MODES, undefined, { patch }, undefined, ["apply_patch"])

		expect(() => patchCall("*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch")).toThrow(
			FileRestrictionError,
		)
		expect(patchCall("*** Begin Patch\n*** Add File: notes.md\n*** End Patch")).toBe(true)
	})

	it("does not admit an opt-in custom tool the model did not include", () => {
		expect(call("apply_patch", { patch: "*** Begin Patch\n*** End Patch" })).toBe(false)
	})

	it("enforces for a tool whose gate list is empty, as soon as its path is known", () => {
		expect(() => call("create_directory", { path: "src/new" })).toThrow(FileRestrictionError)
	})

	it("resolves create_new_workspace's target from path AND name together", () => {
		// Neither alone resolves a target, so enforcement is a safe no-op.
		expect(call("create_new_workspace", { path: "src" })).toBe(true)
		expect(() => call("create_new_workspace", { path: "src", name: "proj" })).toThrow(FileRestrictionError)
	})

	it("accepts a filePath alias where the tool declares one", () => {
		expect(() => call("insert_edit", { filePath: "src/a.ts", line: 1, text: "x" })).toThrow(FileRestrictionError)
	})

	it("refuses a write whose regex does not compile, rather than admitting it", () => {
		const badRegex = {
			slug: "bad",
			name: "Bad",
			roleDefinition: "",
			groups: [],
			tools: [["write", { fileRegex: "([unclosed" }]],
		} as never as ModeConfig

		expect(() =>
			isToolAllowedForMode("write_to_file", "bad", [badRegex], undefined, { path: "a.md", content: "x" }),
		).toThrow(FileRestrictionError)
	})
})
