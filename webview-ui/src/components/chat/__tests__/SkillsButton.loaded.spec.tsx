// npx vitest src/components/chat/__tests__/SkillsButton.loaded.spec.tsx
//
// The skills picker splits its list in two: skills the task has already LOADED
// (which must not reappear under their mode groups) and the rest, grouped by
// the modes that may use them. It also re-asks the host for the list every time
// it opens, because loading a skill changes that split.

import { render, screen, fireEvent } from "@/utils/test-utils"

import type { ModeConfig, SkillMetadata } from "@shofer/types"

import { SkillsButton } from "../SkillsButton"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const state: Record<string, unknown> = {}
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => state,
}))

const skill = (name: string, over: Partial<SkillMetadata> = {}): SkillMetadata =>
	({
		name,
		description: `${name} does things`,
		path: `/skills/${name}/SKILL.md`,
		source: "project",
		...over,
	}) as never

const modes: ModeConfig[] = [
	{ slug: "code", name: "Code", roleDefinition: "", groups: [] },
	{ slug: "debug", name: "Debug", roleDefinition: "", groups: [] },
] as never

const posted = (type: string) => postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === type)

const setState = (over: Record<string, unknown>) => {
	Object.keys(state).forEach((k) => delete state[k])
	Object.assign(state, { skills: [], customModes: modes, loadedSkills: {}, ...over })
}

const open = () => fireEvent.click(screen.getByTestId("skills-button-trigger"))

beforeEach(() => {
	vi.clearAllMocks()
	setState({})
})

describe("SkillsButton", () => {
	it("asks the host for skills on mount, and renders nothing when there are none", () => {
		const { container } = render(<SkillsButton />)
		expect(posted("requestSkills")).toHaveLength(1)
		expect(container).toBeEmptyDOMElement()
	})

	it("re-asks every time the popover opens", () => {
		setState({ skills: [skill("alpha")] })
		render(<SkillsButton />)
		expect(posted("requestSkills")).toHaveLength(1)

		open()
		expect(posted("requestSkills")).toHaveLength(2)
	})

	it("groups the unloaded skills under All Modes and per mode, alphabetically", () => {
		setState({
			skills: [
				skill("zeta"),
				skill("alpha"),
				skill("debugger", { modeSlugs: ["debug"] }),
				skill("coder", { modeSlugs: ["code"] }),
			],
		})
		render(<SkillsButton />)
		open()

		expect(screen.getByText("quickAccess:skills.allModes")).toBeInTheDocument()
		expect(screen.getByText("Code")).toBeInTheDocument()
		expect(screen.getByText("Debug")).toBeInTheDocument()
	})

	it("lists a multi-mode skill under each of its modes", () => {
		setState({ skills: [skill("shared", { modeSlugs: ["code", "debug"] })] })
		render(<SkillsButton />)
		open()
		expect(screen.getAllByTestId("skill-item-shared")).toHaveLength(2)
	})

	it("falls back to the mode slug when the mode is unknown", () => {
		setState({ skills: [skill("odd", { modeSlugs: ["not-a-mode"] })] })
		render(<SkillsButton />)
		open()
		expect(screen.getByText("not-a-mode")).toBeInTheDocument()
	})

	it("moves a loaded skill out of its group into the loaded list", () => {
		setState({
			skills: [skill("alpha"), skill("beta")],
			loadedSkills: { alpha: { name: "alpha" } },
		})
		render(<SkillsButton />)
		open()

		// `alpha` is loaded, so it must not also appear under All Modes.
		expect(screen.getAllByTestId("skill-item-alpha")).toHaveLength(1)
		expect(screen.getAllByTestId("skill-item-beta")).toHaveLength(1)
	})

	it("ignores a loaded skill the metadata no longer carries", () => {
		setState({ skills: [skill("alpha")], loadedSkills: { gone: { name: "gone" } } })
		render(<SkillsButton />)
		open()
		expect(screen.queryByTestId("skill-item-gone")).not.toBeInTheDocument()
	})

	it("inserts an instruction for the chosen skill and closes", () => {
		setState({ skills: [skill("alpha")] })
		render(<SkillsButton />)
		open()

		fireEvent.click(screen.getByTestId("skill-item-alpha"))
		expect(posted("insertTextIntoTextarea")[0]).toMatchObject({ text: "Use the alpha skill" })
		expect(screen.queryByTestId("skill-item-alpha")).not.toBeInTheDocument()
	})

	it("opens a skill's own file without also choosing it", () => {
		setState({ skills: [skill("alpha")] })
		render(<SkillsButton />)
		open()

		fireEvent.click(screen.getByTestId("skill-open-file-alpha"))
		expect(posted("openFile")[0]).toMatchObject({ text: "/skills/alpha/SKILL.md" })
		expect(posted("insertTextIntoTextarea")).toHaveLength(0)
	})

	it("routes the gear to the skills settings section", () => {
		setState({ skills: [skill("alpha")] })
		render(<SkillsButton />)
		open()

		fireEvent.click(screen.getByLabelText("quickAccess:skills.settings"))
		expect(posted("switchTab")[0]).toMatchObject({ tab: "settings", values: { section: "skills" } })
	})
})
