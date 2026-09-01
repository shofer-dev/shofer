import { render, screen } from "@/utils/test-utils"

import type { McpServer } from "@shofer/types"

import { ToolsSettings } from "../ToolsSettings"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const serverWithTool = (group: string | undefined): McpServer[] =>
	[
		{
			name: "acme",
			source: "global",
			status: "connected",
			tools: [{ name: "acme_query", group, enabledForPrompt: true }],
		},
	] as unknown as McpServer[]

describe("ToolsSettings — dynamic categories", () => {
	const setCachedStateField = vi.fn()

	beforeEach(() => vi.clearAllMocks())

	it("gives a tool in a dynamic category its own section, labelled with the raw name", () => {
		render(
			<ToolsSettings
				disabledTools={[]}
				setCachedStateField={setCachedStateField as any}
				mcpServers={serverWithTool("salesforce")}
				dynamicToolGroups={["salesforce"]}
			/>,
		)

		// The tool lands under `salesforce`, not silently in `uncategorized`.
		expect(screen.getByTestId("tool-toggle-mcp--acme--acme_query")).toBeInTheDocument()
		// A dynamic category has no i18n key, so the section labels itself.
		expect(screen.getByText("salesforce")).toBeInTheDocument()
		expect(screen.queryByText("settings:tools.groups.salesforce")).not.toBeInTheDocument()
	})

	it("still sections a category the registry snapshot has not caught up with", () => {
		render(
			<ToolsSettings
				disabledTools={[]}
				setCachedStateField={setCachedStateField as any}
				mcpServers={serverWithTool("salesforce")}
				dynamicToolGroups={[]}
			/>,
		)

		expect(screen.getByTestId("tool-toggle-mcp--acme--acme_query")).toBeInTheDocument()
		expect(screen.getByText("salesforce")).toBeInTheDocument()
	})

	it("keeps rendering the builtin sections from their i18n keys", () => {
		render(
			<ToolsSettings
				disabledTools={[]}
				setCachedStateField={setCachedStateField as any}
				mcpServers={serverWithTool("read")}
				dynamicToolGroups={["salesforce"]}
			/>,
		)

		expect(screen.getByText("settings:tools.groups.read")).toBeInTheDocument()
		expect(screen.getByText("settings:tools.groups.essential")).toBeInTheDocument()
	})
})
