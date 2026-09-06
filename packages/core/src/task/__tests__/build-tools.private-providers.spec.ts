import { BUILTIN_MODES } from "../../__fixtures__/builtin-config.js"

import { createInMemoryHost, getHost, setHost } from "@shofer/types"

import { buildNativeToolsArrayWithRestrictions } from "../build-tools.js"
import { getToolGroupForSayTool } from "../../auto-approval/tools.js"

/** The approval plane's answer for a tool, which takes a `ShoferSayTool`. */
const approvalGroupOf = (toolName: string) => getToolGroupForSayTool({ tool: toolName } as never)
import { toolGroupRegistry } from "../../tool-groups/category-registry.js"

/**
 * PRIVATE-TOOL PROVIDER discovery — the extension-point path by which another
 * VS Code extension contributes tools to the agent.
 *
 * The **Tool-Group Dual-Resolution Rule** is what this file pins. A non-native
 * tool's group is resolved by two independent paths that must agree:
 * `filterPrivateToolsForMode` here (mode VISIBILITY) and
 * `getToolGroupForSayTool` in auto-approval (APPROVAL). What makes them agree
 * is the REGISTRY — whatever accepts a declared group calls
 * `registerToolMapping`. Without that the two disagree silently: the tool is
 * visible as `salesforce` and gated as `uncategorized`, its toggle on and the
 * call still asking.
 *
 * The other rule here is discovery ROBUSTNESS: a provider extension that is not
 * installed, not activated, or crashed must not take the whole tool catalog
 * down with it.
 */

/** Providers declared in config, and what each answers when asked. */
let providers: Record<string, unknown>
let definitionsByCommand: Record<string, unknown>
let providerToolGroups: Record<string, Record<string, string>>
let commandCalls: string[]

function installHost() {
	const bridge = createInMemoryHost()
	setHost({
		...bridge,
		config: {
			...bridge.config,
			get: (section: string, key: string, fallback: unknown) => {
				if (section === "shofer" && key === "privateToolProviders") return providers
				if (key === "toolGroups") return providerToolGroups[section]
				return fallback
			},
		},
		workspace: {
			...bridge.workspace,
			executeCommand: async (command: string) => {
				commandCalls.push(command)
				const answer = definitionsByCommand[command]
				if (answer instanceof Error) throw answer
				return answer
			},
		},
	} as never)
}

const PROVIDER_CONFIG = {
	acme: { getDefinitionsCommand: "acme.getTools", invokeToolCommand: "acme.invoke" },
}

function definition(name: string, extra: Record<string, unknown> = {}) {
	return { name, description: `the ${name} tool`, inputSchema: { type: "object", properties: {} }, ...extra }
}

async function buildFor(mode: string) {
	return buildNativeToolsArrayWithRestrictions({
		provider: { getMcpHub: () => undefined } as never,
		cwd: "/ws",
		mode,
		customModes: BUILTIN_MODES,
		experiments: {},
		apiConfiguration: {},
		modelInfo: { contextWindow: 100_000 } as never,
		includeAllToolsWithRestrictions: false,
	})
}

const toolNamesIn = (result: { tools: unknown[] }) =>
	result.tools
		.map((t) => (t as { function?: { name?: string } }).function?.name)
		.filter((name): name is string => !!name)

let previousHost: ReturnType<typeof getHost>

beforeEach(() => {
	previousHost = getHost()
	providers = {}
	definitionsByCommand = {}
	providerToolGroups = {}
	commandCalls = []
	toolGroupRegistry.reset()
	installHost()
})

afterEach(() => {
	setHost(previousHost)
})

describe("discovery", () => {
	it("asks each configured provider for its definitions and adds them to the catalog", async () => {
		providers = PROVIDER_CONFIG
		definitionsByCommand["acme.getTools"] = [definition("acme_search", { group: "read" })]

		const result = await buildFor("code")

		expect(commandCalls).toEqual(["acme.getTools"])
		expect(toolNamesIn(result)).toContain("acme_search")
	})

	it("skips a provider that declares neither command", async () => {
		providers = { broken: { getDefinitionsCommand: "only.this" } }

		await buildFor("code")

		expect(commandCalls).toEqual([])
	})

	it("survives a provider that is not installed, not activated, or crashed", async () => {
		providers = PROVIDER_CONFIG
		definitionsByCommand["acme.getTools"] = new Error("command 'acme.getTools' not found")

		const result = await buildFor("code")

		// The native catalog is intact; only the provider's tools are missing.
		expect(toolNamesIn(result).length).toBeGreaterThan(0)
	})

	it("ignores a provider that answers with something other than an array", async () => {
		providers = PROVIDER_CONFIG
		definitionsByCommand["acme.getTools"] = { not: "an array" }

		const result = await buildFor("code")

		expect(toolNamesIn(result)).not.toContain("acme_search")
	})

	it("falls back to the tool's name when it carries no description or schema", async () => {
		providers = PROVIDER_CONFIG
		definitionsByCommand["acme.getTools"] = [{ name: "bare_tool", group: "read" }]

		const result = await buildFor("code")

		const tool = result.tools.find(
			(t) => (t as { function?: { name?: string } }).function?.name === "bare_tool",
		) as { function: { description?: string; parameters?: unknown } }
		expect(tool.function.description).toBe("bare_tool")
		expect(tool.function.parameters).toEqual({ type: "object", properties: {} })
	})
})

describe("group resolution — and the registry that keeps both paths in step", () => {
	it("takes the group the DEFINITION declares, and registers it", async () => {
		providers = PROVIDER_CONFIG
		definitionsByCommand["acme.getTools"] = [definition("acme_lead", { group: "salesforce" })]

		await buildFor("code")

		// The approval path resolves the same category, because discovery
		// registered the mapping rather than relying on a naming convention.
		expect(approvalGroupOf("acme_lead")).toBe("salesforce")
		expect(toolGroupRegistry.getDynamicGroups()).toContain("salesforce")
	})

	it("falls back to the PROVIDER's config when the definition declares none", async () => {
		providers = PROVIDER_CONFIG
		providerToolGroups["shofer.acme"] = { acme_lead: "salesforce" }
		definitionsByCommand["acme.getTools"] = [definition("acme_lead")]

		await buildFor("code")

		expect(approvalGroupOf("acme_lead")).toBe("salesforce")
	})

	it("falls back to uncategorized for a malformed group name", async () => {
		providers = PROVIDER_CONFIG
		definitionsByCommand["acme.getTools"] = [definition("acme_lead", { group: "Not A Slug" })]

		await buildFor("code")

		expect(approvalGroupOf("acme_lead")).toBe("uncategorized")
	})

	it("ignores a provider config whose entry is not a string", async () => {
		providers = PROVIDER_CONFIG
		providerToolGroups["shofer.acme"] = { acme_lead: 42 as never }
		definitionsByCommand["acme.getTools"] = [definition("acme_lead")]

		await buildFor("code")

		expect(approvalGroupOf("acme_lead")).toBe("uncategorized")
	})

	it("prefers a browser-DECLARED group over what the name would imply", async () => {
		// Prefix inference is the last resort; a declared group wins, which is the
		// whole point of registering the mapping at discovery.
		providers = PROVIDER_CONFIG
		definitionsByCommand["acme.getTools"] = [definition("browser_click", { group: "salesforce" })]

		await buildFor("code")

		expect(approvalGroupOf("browser_click")).toBe("salesforce")
	})
})

describe("mode visibility", () => {
	it("offers a read-grouped private tool to a mode that reads", async () => {
		providers = PROVIDER_CONFIG
		definitionsByCommand["acme.getTools"] = [definition("acme_search", { group: "read" })]

		expect(toolNamesIn(await buildFor("code-search"))).toContain("acme_search")
	})

	it("withholds a write-grouped private tool from a mode that cannot write", async () => {
		// `code-search` carries read/execute/browser/mcp/questions — no write.
		providers = PROVIDER_CONFIG
		definitionsByCommand["acme.getTools"] = [definition("acme_mutate", { group: "write" })]

		expect(toolNamesIn(await buildFor("code-search"))).not.toContain("acme_mutate")
	})
})

describe("a conversational turn", () => {
	it("assembles NO tool plane at all, so no provider is even asked", async () => {
		providers = PROVIDER_CONFIG
		definitionsByCommand["acme.getTools"] = [definition("acme_search", { group: "read" })]

		const result = await buildNativeToolsArrayWithRestrictions({
			provider: { getMcpHub: () => undefined } as never,
			cwd: "/ws",
			mode: "code",
			customModes: BUILTIN_MODES,
			experiments: {},
			apiConfiguration: { toolCallingEnabled: false },
			modelInfo: { contextWindow: 100_000 } as never,
			includeAllToolsWithRestrictions: false,
		})

		expect(result.tools).toEqual([])
		expect(commandCalls).toEqual([])
	})
})
