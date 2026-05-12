import { render, screen, fireEvent } from "@/utils/test-utils"

import type { Command } from "@shofer/types"

import { CommandsButton } from "../CommandsButton"

const mockPostMessage = vi.fn()

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: (...args: unknown[]) => mockPostMessage(...args),
	},
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@/components/ui/hooks/useShoferPortal", () => ({
	useShoferPortal: () => document.body,
}))

const mockUseExtensionState = vi.fn()

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockUseExtensionState(),
}))

function setCommands(commands: Command[]) {
	mockUseExtensionState.mockReturnValue({
		commands,
	})
}

const mockProjectCommands: Command[] = [
	{ name: "commit", source: "project", description: "Commit in separate commits", filePath: "/test/commit.md" },
	{
		name: "merge-worktree",
		source: "project",
		description: "Merge a worktree",
		filePath: "/test/merge.md",
		argumentHint: "<branch>",
	},
]

const mockGlobalCommands: Command[] = [
	{ name: "init", source: "global", description: "Initialize project", filePath: "/test/init.md" },
]

const mockBuiltInCommands: Command[] = [{ name: "use_skill", source: "built-in", description: "Load a skill" }]

describe("CommandsButton", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders nothing when there are no commands", () => {
		setCommands([])
		const { container } = render(<CommandsButton />)
		expect(container.firstChild).toBeNull()
	})

	it("renders the trigger button when commands exist", () => {
		setCommands(mockProjectCommands)
		render(<CommandsButton />)
		expect(screen.getByTestId("commands-button-trigger")).toBeInTheDocument()
	})

	it("opens popover when trigger is clicked", () => {
		setCommands(mockProjectCommands)
		render(<CommandsButton />)

		fireEvent.click(screen.getByTestId("commands-button-trigger"))
		expect(screen.getByText("quickAccess:commands.title")).toBeInTheDocument()
	})

	it("groups commands by source", () => {
		setCommands([...mockProjectCommands, ...mockGlobalCommands, ...mockBuiltInCommands])
		render(<CommandsButton />)

		fireEvent.click(screen.getByTestId("commands-button-trigger"))

		// Check group headers are present
		expect(screen.getByText("quickAccess:commands.projectCommands")).toBeInTheDocument()
		expect(screen.getByText("quickAccess:commands.globalCommands")).toBeInTheDocument()
		expect(screen.getByText("quickAccess:commands.builtInCommands")).toBeInTheDocument()

		// Check individual commands are listed
		expect(screen.getByTestId("command-item-commit")).toBeInTheDocument()
		expect(screen.getByTestId("command-item-merge-worktree")).toBeInTheDocument()
		expect(screen.getByTestId("command-item-init")).toBeInTheDocument()
		expect(screen.getByTestId("command-item-use_skill")).toBeInTheDocument()
	})

	it("inserts command text on click", () => {
		setCommands(mockProjectCommands)
		render(<CommandsButton />)

		fireEvent.click(screen.getByTestId("commands-button-trigger"))
		fireEvent.click(screen.getByTestId("command-item-commit"))

		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "insertTextIntoTextarea",
			text: "/commit ",
		})
	})

	it("inserts command text with argumentHint when present", () => {
		setCommands(mockProjectCommands)
		render(<CommandsButton />)

		fireEvent.click(screen.getByTestId("commands-button-trigger"))
		fireEvent.click(screen.getByTestId("command-item-merge-worktree"))

		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "insertTextIntoTextarea",
			text: "/merge-worktree <branch>",
		})
	})

	it("closes popover after command selection", () => {
		setCommands(mockProjectCommands)
		render(<CommandsButton />)

		// Open popover
		fireEvent.click(screen.getByTestId("commands-button-trigger"))
		expect(screen.getByTestId("command-item-commit")).toBeInTheDocument()

		// Click a command
		fireEvent.click(screen.getByTestId("command-item-commit"))

		// Popover should close — the item should no longer be visible
		expect(screen.queryByTestId("command-item-commit")).not.toBeInTheDocument()
	})

	it("opens settings when gear icon is clicked", () => {
		setCommands(mockProjectCommands)
		render(<CommandsButton />)

		fireEvent.click(screen.getByTestId("commands-button-trigger"))

		const gearButton = document.querySelector(".codicon-settings-gear")
		expect(gearButton).toBeInTheDocument()
		fireEvent.click(gearButton!)

		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "switchTab",
			tab: "settings",
			values: { section: "slashCommands" },
		})
	})

	it("only shows groups that have commands", () => {
		setCommands(mockProjectCommands)
		render(<CommandsButton />)

		fireEvent.click(screen.getByTestId("commands-button-trigger"))

		// Only project commands group should be visible
		expect(screen.getByText("quickAccess:commands.projectCommands")).toBeInTheDocument()
		expect(screen.queryByText("quickAccess:commands.globalCommands")).not.toBeInTheDocument()
		expect(screen.queryByText("quickAccess:commands.builtInCommands")).not.toBeInTheDocument()
	})

	it("shows open-file button when command has filePath", () => {
		setCommands(mockProjectCommands)
		render(<CommandsButton />)

		fireEvent.click(screen.getByTestId("commands-button-trigger"))

		// commit has filePath, so open-file button should exist
		expect(screen.getByTestId("command-open-file-commit")).toBeInTheDocument()
		// use_skill has no filePath, so no open-file button
		expect(screen.queryByTestId("command-open-file-use_skill")).not.toBeInTheDocument()
	})

	it("sends openFile message when open-file button is clicked", () => {
		setCommands(mockProjectCommands)
		render(<CommandsButton />)

		fireEvent.click(screen.getByTestId("commands-button-trigger"))

		const openFileBtn = screen.getByTestId("command-open-file-commit")
		fireEvent.click(openFileBtn)

		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "openFile",
			text: "/test/commit.md",
		})
	})

	it("open-file button click does not close the popover", () => {
		setCommands(mockProjectCommands)
		render(<CommandsButton />)

		fireEvent.click(screen.getByTestId("commands-button-trigger"))

		const openFileBtn = screen.getByTestId("command-open-file-commit")
		fireEvent.click(openFileBtn)

		// Popover should still be open
		expect(screen.getByTestId("command-item-commit")).toBeInTheDocument()
	})
})
