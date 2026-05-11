import { render, screen, fireEvent } from "@/utils/test-utils"

import type { SkillMetadata, ModeConfig } from "@roo-code/types"

import { SkillsButton } from "../SkillsButton"

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

vi.mock("@/components/ui/hooks/useRooPortal", () => ({
	useRooPortal: () => document.body,
}))

const mockUseExtensionState = vi.fn()

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockUseExtensionState(),
}))

function setSkills(skills: SkillMetadata[], customModes: ModeConfig[] = []) {
	mockUseExtensionState.mockReturnValue({
		skills,
		customModes,
	})
}

const mockAllModesSkill: SkillMetadata = {
	name: "eauction-search",
	description: "Search for properties on eauction.gr",
	path: "/test/eauction/SKILL.md",
	source: "project",
}

const mockCodeModeSkill: SkillMetadata = {
	name: "test",
	description: "Test skill for code mode",
	path: "/test/test/SKILL.md",
	source: "project",
	modeSlugs: ["code"],
}

const mockDebugModeSkill: SkillMetadata = {
	name: "debug-helper",
	description: "Debug assistance",
	path: "/test/debug/SKILL.md",
	source: "global",
	modeSlugs: ["debug"],
}

const mockMultiModeSkill: SkillMetadata = {
	name: "analyzer",
	description: "Analysis across modes",
	path: "/test/analyze/SKILL.md",
	source: "project",
	modeSlugs: ["code", "architect"],
}

const mockCustomModes: ModeConfig[] = [
	{ slug: "code", name: "Code", description: "Write code", roleDefinition: "", groups: ["read", "write"] },
	{
		slug: "debug",
		name: "Debug",
		description: "Debug issues",
		roleDefinition: "",
		groups: ["read", "write"],
	},
	{
		slug: "architect",
		name: "Architect",
		description: "Design systems",
		roleDefinition: "",
		groups: ["read"],
	},
]

describe("SkillsButton", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders nothing when there are no skills", () => {
		setSkills([])
		const { container } = render(<SkillsButton />)
		expect(container.firstChild).toBeNull()
	})

	it("renders the trigger button when skills exist", () => {
		setSkills([mockAllModesSkill])
		render(<SkillsButton />)
		expect(screen.getByTestId("skills-button-trigger")).toBeInTheDocument()
	})

	it("opens popover when trigger is clicked", () => {
		setSkills([mockAllModesSkill])
		render(<SkillsButton />)

		fireEvent.click(screen.getByTestId("skills-button-trigger"))
		expect(screen.getByText("quickAccess:skills.title")).toBeInTheDocument()
	})

	it("groups skills by mode restriction", () => {
		setSkills([mockAllModesSkill, mockCodeModeSkill, mockDebugModeSkill, mockMultiModeSkill], mockCustomModes)
		render(<SkillsButton />)

		fireEvent.click(screen.getByTestId("skills-button-trigger"))

		// "All Modes" group
		expect(screen.getByText("quickAccess:skills.allModes")).toBeInTheDocument()
		expect(screen.getByTestId("skill-item-eauction-search")).toBeInTheDocument()

		// Per-mode groups (using custom mode names)
		expect(screen.getByText("Code")).toBeInTheDocument()
		expect(screen.getByTestId("skill-item-test")).toBeInTheDocument()
		// analyzer has modeSlugs: ["code", "architect"] — appears in both groups
		expect(screen.getAllByTestId("skill-item-analyzer")).toHaveLength(2)

		expect(screen.getByText("Debug")).toBeInTheDocument()
		expect(screen.getByTestId("skill-item-debug-helper")).toBeInTheDocument()

		expect(screen.getByText("Architect")).toBeInTheDocument()
	})

	it("inserts skill instruction text on click", () => {
		setSkills([mockAllModesSkill])
		render(<SkillsButton />)

		fireEvent.click(screen.getByTestId("skills-button-trigger"))
		fireEvent.click(screen.getByTestId("skill-item-eauction-search"))

		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "insertTextIntoTextarea",
			text: "Use the eauction-search skill",
		})
	})

	it("closes popover after skill selection", () => {
		setSkills([mockAllModesSkill])
		render(<SkillsButton />)

		// Open popover
		fireEvent.click(screen.getByTestId("skills-button-trigger"))
		expect(screen.getByTestId("skill-item-eauction-search")).toBeInTheDocument()

		// Click a skill
		fireEvent.click(screen.getByTestId("skill-item-eauction-search"))

		// Popover should close
		expect(screen.queryByTestId("skill-item-eauction-search")).not.toBeInTheDocument()
	})

	it("opens settings when gear icon is clicked", () => {
		setSkills([mockAllModesSkill])
		render(<SkillsButton />)

		fireEvent.click(screen.getByTestId("skills-button-trigger"))

		const gearButton = document.querySelector(".codicon-settings-gear")
		expect(gearButton).toBeInTheDocument()
		fireEvent.click(gearButton!)

		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "switchTab",
			tab: "settings",
			values: { section: "skills" },
		})
	})

	it("only shows 'All Modes' group when all skills are unrestricted", () => {
		setSkills([mockAllModesSkill, { ...mockAllModesSkill, name: "another-skill", description: "Another" }])
		render(<SkillsButton />)

		fireEvent.click(screen.getByTestId("skills-button-trigger"))

		expect(screen.getByText("quickAccess:skills.allModes")).toBeInTheDocument()
		expect(screen.queryByText("Code")).not.toBeInTheDocument()
	})

	it("uses mode slug as fallback label when custom mode not found", () => {
		setSkills([{ ...mockCodeModeSkill, modeSlugs: ["unknown-mode"] }], [])
		render(<SkillsButton />)

		fireEvent.click(screen.getByTestId("skills-button-trigger"))

		// Should fallback to the slug
		expect(screen.getByText("unknown-mode")).toBeInTheDocument()
	})

	it("does not show empty groups", () => {
		// Only allModes skill — no mode-specific groups should show
		setSkills([mockAllModesSkill], mockCustomModes)
		render(<SkillsButton />)

		fireEvent.click(screen.getByTestId("skills-button-trigger"))

		expect(screen.getByText("quickAccess:skills.allModes")).toBeInTheDocument()
		expect(screen.queryByText("Code")).not.toBeInTheDocument()
	})
})
