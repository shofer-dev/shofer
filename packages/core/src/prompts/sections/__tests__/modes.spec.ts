// Private modes must be invisible to the model: the MODES section is the
// LLM-facing enumeration, and a private (plugin-internal) mode advertised there
// would spend prompt bytes on a mode the agent is never meant to pick.

import type { ModeConfig } from "@shofer/types"
import { createInMemoryHost, setHost } from "@shofer/types"

import { getModesSection } from "../modes.js"

function mode(slug: string, extra: Partial<ModeConfig> = {}): ModeConfig {
	return {
		slug,
		name: slug,
		roleDefinition: `You are the ${slug} mode. Do ${slug} things.`,
		tools: ["read"],
		...extra,
	}
}

describe("getModesSection", () => {
	afterEach(() => {
		setHost(createInMemoryHost())
	})

	function hostWithModes(customModes: ModeConfig[]) {
		const host = createInMemoryHost()
		host.state.readModeOverrides = async () => ({ customModes, customModePrompts: {} })
		setHost(host)
	}

	it("lists public modes", async () => {
		hostWithModes([mode("code"), mode("architect")])
		const section = await getModesSection()
		expect(section).toContain("(code)")
		expect(section).toContain("(architect)")
	})

	it("omits private modes entirely", async () => {
		hostWithModes([mode("code"), mode("second-brain:default", { private: true, whenToUse: "detector duty" })])
		const section = await getModesSection()
		expect(section).toContain("(code)")
		expect(section).not.toContain("second-brain:default")
		expect(section).not.toContain("detector duty")
	})

	it("keeps a public mode that merely shares a prefix with a private one", async () => {
		hostWithModes([mode("second-brainstorm"), mode("second-brain:git-log", { private: true })])
		const section = await getModesSection()
		expect(section).toContain("(second-brainstorm)")
		expect(section).not.toContain("second-brain:git-log")
	})
})
