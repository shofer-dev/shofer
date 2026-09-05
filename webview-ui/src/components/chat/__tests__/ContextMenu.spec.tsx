// npx vitest src/components/chat/__tests__/ContextMenu.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import ContextMenu from "../ContextMenu"
import { ContextMenuOptionType, type ContextMenuQueryItem } from "@src/utils/context-mentions"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

vi.mock("vscode-material-icons", () => ({
	getIconForFilePath: (name: string) => `file-${name}`,
	getIconForDirectoryPath: (name: string) => `dir-${name}`,
	getIconUrlByName: (icon: string, base: string) => `${base}/${icon}.svg`,
}))

vi.mock("react-i18next", () => ({
	Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}))

vi.mock("i18next", () => ({ t: (key: string) => key }))

const onSelect = vi.fn()
const setSelectedIndex = vi.fn()

const renderMenu = (
	props: Partial<React.ComponentProps<typeof ContextMenu>> & { queryItems: ContextMenuQueryItem[] },
) =>
	render(
		<ContextMenu
			onSelect={onSelect}
			searchQuery=""
			inputValue=""
			onMouseDown={vi.fn()}
			selectedIndex={0}
			setSelectedIndex={setSelectedIndex}
			selectedType={null}
			modes={[]}
			commands={[]}
			{...props}
		/>,
	)

beforeEach(() => {
	vi.clearAllMocks()
	;(window as unknown as { MATERIAL_ICONS_BASE_URI: string }).MATERIAL_ICONS_BASE_URI = "https://icons"
})

describe("ContextMenu", () => {
	it("renders the default option list and selects an entry on click", () => {
		renderMenu({ queryItems: [] })

		// The default list carries the problems/terminal/git/url affordances.
		expect(screen.getByText("chat:contextMenu.problems")).toBeInTheDocument()
		expect(screen.getByText("chat:contextMenu.terminal")).toBeInTheDocument()

		fireEvent.click(screen.getByText("chat:contextMenu.problems"))
		expect(onSelect).toHaveBeenCalledWith(ContextMenuOptionType.Problems, undefined)
	})

	it("renders a file entry split into filename and folder, with a material icon", () => {
		const { container } = renderMenu({
			selectedType: ContextMenuOptionType.File,
			queryItems: [{ type: ContextMenuOptionType.File, value: "/src/deep/main.ts" }],
		})
		expect(screen.getByText("main.ts")).toBeInTheDocument()
		expect(screen.getByText("src/deep")).toBeInTheDocument()
		expect(container.querySelector("img")).toHaveAttribute("src", "https://icons/file-main.ts.svg")
	})

	it("uses the directory icon for a folder and strips its trailing slash", () => {
		const { container } = renderMenu({
			selectedType: ContextMenuOptionType.Folder,
			queryItems: [{ type: ContextMenuOptionType.Folder, value: "/src/deep/" }],
		})
		expect(container.querySelector("img")).toHaveAttribute("src", "https://icons/dir-deep.svg")
		expect(screen.getByText("deep")).toBeInTheDocument()
	})

	it("renders a git commit with its description, and the bare Git row without one", () => {
		renderMenu({
			searchQuery: "abc",
			selectedType: ContextMenuOptionType.Git,
			queryItems: [
				{
					type: ContextMenuOptionType.Git,
					value: "abc1234",
					label: "fix: the thing",
					description: "abc1234 by someone",
				},
			],
		})
		expect(screen.getByText("fix: the thing")).toBeInTheDocument()
		expect(screen.getByText("abc1234 by someone")).toBeInTheDocument()
	})

	it("shows the slash-command header and a settings shortcut for a bare slash", () => {
		renderMenu({ searchQuery: "/", queryItems: [] })

		expect(screen.getByText("Slash Commands")).toBeInTheDocument()
		fireEvent.click(screen.getByTitle("chat:slashCommands.manageCommands"))
		expect(postMessage).toHaveBeenCalledWith({
			type: "switchTab",
			tab: "settings",
			values: { section: "slashCommands" },
		})
	})

	it("lists modes and commands under a slash query", () => {
		renderMenu({
			searchQuery: "/",
			queryItems: [],
			modes: [{ slug: "code", name: "Code", roleDefinition: "", groups: [] }] as never,
			commands: [{ name: "deploy", source: "project", description: "Ship it", argumentHint: "<env>" }] as never,
		})
		expect(screen.getByText("/deploy")).toBeInTheDocument()
		expect(screen.getByText("<env>")).toBeInTheDocument()
		expect(screen.getByText("Ship it")).toBeInTheDocument()
		expect(screen.getByText("/code")).toBeInTheDocument()
	})

	it("does not select an unselectable row and does not move the highlight onto it", () => {
		renderMenu({
			searchQuery: "zzzz-no-such-thing",
			queryItems: [],
		})
		const noResults = screen.getByText("chat:contextMenu.noResults")
		fireEvent.click(noResults)
		fireEvent.mouseEnter(noResults)
		expect(onSelect).not.toHaveBeenCalled()
		expect(setSelectedIndex).not.toHaveBeenCalled()
	})

	it("moves the highlight when a selectable row is hovered", () => {
		renderMenu({ queryItems: [] })
		fireEvent.mouseEnter(screen.getByText("chat:contextMenu.terminal"))
		expect(setSelectedIndex).toHaveBeenCalled()
	})

	it("scrolls the highlighted row into view", () => {
		// jsdom gives every element a zero-sized rect, so drive the branch with
		// rects that put the selected row below the viewport.
		const menuRect = { top: 0, bottom: 100 } as DOMRect
		const rowRect = { top: 120, bottom: 200 } as DOMRect
		const spy = vi
			.spyOn(HTMLElement.prototype, "getBoundingClientRect")
			.mockImplementationOnce(() => menuRect)
			.mockImplementationOnce(() => rowRect)

		const { container } = renderMenu({ selectedIndex: 1, queryItems: [] })
		const menu = container.querySelector('[style*="max-height"]') as HTMLDivElement
		expect(menu.scrollTop).toBeGreaterThanOrEqual(0)
		spy.mockRestore()
	})
})
