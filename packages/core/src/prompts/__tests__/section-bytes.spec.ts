// Per-section byte measurement of the assembled system prompt.
//
// Run it for the numbers (vitest is silent by default, so `--no-silent` is what
// makes the table appear):
//
//   npx vitest run --no-silent packages/core/src/prompts/__tests__/section-bytes.spec.ts
//
// # Why a harness rather than a one-off script
//
// Trimming the prompt is only worth doing where the bytes actually are, and the
// intuition is unreliable: RULES is several times MARKDOWN RULES, and the
// tool-use pair is bigger than both. Measuring is also the only way to know
// whether a gate is worth its wiring — a section worth 200 bytes is noise next
// to a tool schema array in the tens of kilobytes.
//
// It doubles as the regression test that every gate is REACHABLE: each one is
// asserted to remove its own section and nothing else, which a table printed by
// a script nobody runs would not catch.
//
// # What "a mode's prompt" means here
//
// The sections are assembled for a MODE, and two of them (MODES, CAPABILITIES)
// depend on which modes exist and which tool groups the mode carries. The
// fixture below is therefore a chat-shaped mode — MCP tools, questions and
// subtasks, no file tools — beside a second mode, which is the shape a headless
// conversational deployment has. A workspace mode with the read/write/execute
// groups renders a longer CAPABILITIES section; the other sections are
// mode-independent.

vi.mock("os", () => {
	const os = {
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
	}
	return { default: os, ...os }
})

vi.mock("default-shell", () => ({ default: "/bin/bash" }))
vi.mock("os-name", () => ({ default: () => "Linux" }))

import { setHost, createInMemoryHost, type ModeConfig } from "@shofer/types"

import { SYSTEM_PROMPT } from "../system.js"
import type { SystemPromptSettings } from "../types.js"

const CWD = "/workspace"

/**
 * A chat-shaped mode pair: the `mcp` group is what exposes an MCP catalog's
 * tools, `questions` grants ask_followup_question, `subtasks` the delegation
 * set, and the empty exclusive allow-lists on `read`/`write` grant no native
 * file tools while keeping the group names on the mode.
 */
const CHAT_MODES: ModeConfig[] = [
	{
		slug: "orchestrator",
		name: "Orchestrator",
		roleDefinition: "You are an orchestrator. You operate a platform and delegate work; you edit no files.",
		whenToUse: "Use for operating infrastructure and delegating work.",
		description: "Operates infrastructure and delegates work",
		tools: ["mcp", "questions", "subtasks", { read: { allowed: [] } }, { write: { allowed: [] } }],
	},
	{
		slug: "observability",
		name: "Observability",
		roleDefinition: "You answer questions about what the platform is doing right now.",
		whenToUse: "Use for reading metrics, logs and traces.",
		description: "Reads metrics, logs and traces",
		tools: ["questions"],
	},
]

const BASE_SETTINGS: SystemPromptSettings = {
	todoListEnabled: true,
	useAgentRules: false,
	newTaskRequireTodos: false,
	enableSubfolderRules: false,
}

/** Every gate this harness measures, with the settings key that turns it off. */
const GATES = [
	["MARKDOWN RULES", "includeMarkdownFormatting"],
	["TOOL USE + Tool Use Guidelines", "includeToolUse"],
	["CAPABILITIES", "includeCapabilities"],
	["MODES", "includeModes"],
	["RULES", "includeRules"],
	["SYSTEM INFORMATION", "includeSystemInfo"],
	["OBJECTIVE", "includeObjective"],
] as const satisfies readonly (readonly [string, keyof SystemPromptSettings])[]

async function buildPrompt(overrides: Partial<SystemPromptSettings> = {}): Promise<string> {
	return SYSTEM_PROMPT(
		{} as never, // context — only checked for presence
		CWD,
		false, // supportsComputerUse
		undefined, // mcpHub
		undefined, // diffStrategy
		"orchestrator",
		undefined, // customModePrompts
		CHAT_MODES,
		undefined, // globalCustomInstructions
		{}, // experiments
		"en", // language
		undefined, // shoferIgnoreInstructions
		{ ...BASE_SETTINGS, ...overrides },
	)
}

describe("system prompt: per-section bytes", () => {
	beforeEach(() => {
		// The MODES section reads the effective mode list through the host's
		// `state` capability, so the in-memory host is given the same two modes
		// the prompt is assembled for.
		setHost({ ...createInMemoryHost(), state: { readModeOverrides: async () => ({ customModes: CHAT_MODES }) } })
	})

	it("prints the byte cost of every gated section", async () => {
		const full = await buildPrompt()
		const rows: { section: string; bytes: number }[] = []
		for (const [label, key] of GATES) {
			const without = await buildPrompt({ [key]: false })
			rows.push({ section: label, bytes: Buffer.byteLength(full) - Buffer.byteLength(without) })
		}

		const gated = rows.reduce((sum, r) => sum + r.bytes, 0)
		const total = Buffer.byteLength(full)
		const width = Math.max(...rows.map((r) => r.section.length))
		const lines = [
			"",
			`system prompt: ${total} bytes total (mode "orchestrator", ${CHAT_MODES.length} modes, no MCP hub)`,
			...rows
				.slice()
				.sort((a, b) => b.bytes - a.bytes)
				.map(
					(r) =>
						`  ${r.section.padEnd(width)}  ${String(r.bytes).padStart(6)}  ${((r.bytes / total) * 100).toFixed(1).padStart(5)}%`,
				),
			`  ${"(ungated: role definition, custom instructions, separators)".padEnd(width)}  ${String(total - gated).padStart(6)}  ${(((total - gated) / total) * 100).toFixed(1).padStart(5)}%`,
			"",
		]
		console.log(lines.join("\n"))

		// Every gate must be worth a non-zero number of bytes; a zero would mean
		// the gate reaches a section that is not being rendered, which makes the
		// measurement a lie rather than a small saving.
		for (const row of rows) {
			expect(row.bytes, `${row.section} saved no bytes`).toBeGreaterThan(0)
		}
		expect(gated).toBeLessThan(total)
	})

	it("removes exactly the gated section and leaves the others", async () => {
		const markers: Record<string, string> = {
			includeMarkdownFormatting: "MARKDOWN RULES",
			includeToolUse: "TOOL USE",
			includeCapabilities: "CAPABILITIES",
			includeModes: "MODES",
			includeRules: "RULES",
			includeObjective: "OBJECTIVE",
		}
		for (const [key, marker] of Object.entries(markers)) {
			const prompt = await buildPrompt({ [key]: false })
			// "RULES" is a substring of "MARKDOWN RULES", so the headings are
			// matched with their `====` banner rather than as bare words.
			expect(prompt, `${key} left its section in`).not.toContain(`====\n\n${marker}`)
			for (const [otherKey, otherMarker] of Object.entries(markers)) {
				if (otherKey === key || otherMarker.startsWith(marker) || marker.startsWith(otherMarker)) continue
				expect(prompt, `${key} also removed ${otherMarker}`).toContain(`====\n\n${otherMarker}`)
			}
		}
	})

	// The gates exist to be set STATICALLY per deployment. A prompt that changed
	// between turns would cost more than the sections save, because the
	// provider's prompt-prefix cache only pays while the prefix is byte-stable.
	// Nothing here varies per turn, and this is what says so.
	it("is byte-identical across repeated assembly with the same settings", async () => {
		const [first, second] = await Promise.all([buildPrompt(), buildPrompt()])
		expect(first).toEqual(second)
	})

	// The whole point of defaulting every gate to "included": a caller that sets
	// none must get the prompt it got before the gates existed.
	it("assembles identically for `true` and for an unset gate", async () => {
		const unset = await buildPrompt()
		const explicit = await buildPrompt({
			includeMarkdownFormatting: true,
			includeToolUse: true,
			includeCapabilities: true,
			includeModes: true,
			includeRules: true,
			includeObjective: true,
			includeSystemInfo: true,
		})
		expect(explicit).toEqual(unset)
	})
})
