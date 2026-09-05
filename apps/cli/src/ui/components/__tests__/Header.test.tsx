import { render } from "ink-testing-library"

import type { TokenUsage } from "@shofer/types"

import { TerminalSizeProvider } from "../../hooks/TerminalSizeContext.js"
import Header from "../Header.js"

type HeaderProps = Parameters<typeof Header>[0]

const baseProps = (over: Partial<HeaderProps> = {}): HeaderProps =>
	({
		mode: "code",
		user: null,
		provider: "shofer",
		model: "some-model",
		reasoningEffort: "medium",
		workspacePath: "/tmp/project",
		extensionPath: "/tmp/ext",
		ephemeral: false,
		version: "1.2.3",
		...over,
	}) as HeaderProps

const renderHeader = (props: Partial<HeaderProps> = {}) =>
	render(
		<TerminalSizeProvider>
			<Header {...baseProps(props)} />
		</TerminalSizeProvider>,
	)

describe("Header", () => {
	const originalColumns = process.stdout.columns
	const originalHome = process.env.HOME
	const originalUserProfile = process.env.USERPROFILE

	beforeEach(() => {
		Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true })
	})

	afterEach(() => {
		Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true })
		if (originalHome === undefined) delete process.env.HOME
		else process.env.HOME = originalHome
		if (originalUserProfile === undefined) delete process.env.USERPROFILE
		else process.env.USERPROFILE = originalUserProfile
	})

	it("renders the version banner", () => {
		const { lastFrame } = renderHeader()
		expect(lastFrame()).toContain("Shofer CLI v1.2.3")
	})

	it("renders the provider, model and reasoning effort", () => {
		const { lastFrame } = renderHeader({ provider: "anthropic", model: "opus", reasoningEffort: "high" })
		const output = lastFrame()

		expect(output).toContain("anthropic")
		expect(output).toContain("opus")
		expect(output).toContain("[high]")
	})

	it("renders the mode", () => {
		const { lastFrame } = renderHeader({ mode: "architect" })
		expect(lastFrame()).toContain("mode: architect")
	})

	it("marks a non-interactive run as YOLO", () => {
		const { lastFrame } = renderHeader({ nonInteractive: true })
		expect(lastFrame()).toContain("(YOLO)")
	})

	it("does not mark an interactive run", () => {
		const { lastFrame } = renderHeader({ nonInteractive: false })
		expect(lastFrame()).not.toContain("YOLO")
	})

	it("greets a signed-in user", () => {
		const { lastFrame } = renderHeader({ user: { name: "Ada" } as HeaderProps["user"] })
		expect(lastFrame()).toContain("Welcome back, Ada")
	})

	it("omits the greeting when there is no user", () => {
		const { lastFrame } = renderHeader({ user: null })
		expect(lastFrame()).not.toContain("Welcome back")
	})

	it("abbreviates a workspace under the home directory to ~", () => {
		process.env.HOME = "/home/ada"
		const { lastFrame } = renderHeader({ workspacePath: "/home/ada/work/proj" })
		const output = lastFrame()

		expect(output).toContain("~/work/proj")
		expect(output).not.toContain("/home/ada/work")
	})

	it("leaves a workspace outside the home directory intact", () => {
		process.env.HOME = "/home/ada"
		const { lastFrame } = renderHeader({ workspacePath: "/srv/proj" })
		expect(lastFrame()).toContain("/srv/proj")
	})

	it("falls back to USERPROFILE when HOME is unset", () => {
		delete process.env.HOME
		process.env.USERPROFILE = "/users/ada"
		const { lastFrame } = renderHeader({ workspacePath: "/users/ada/proj" })
		expect(lastFrame()).toContain("~/proj")
	})

	it("tolerates neither HOME nor USERPROFILE being set", () => {
		delete process.env.HOME
		delete process.env.USERPROFILE
		const { lastFrame } = renderHeader({ workspacePath: "/srv/proj" })
		expect(lastFrame()).toContain("/srv/proj")
	})

	it("renders the metrics strip when usage and a context window are present", () => {
		const tokenUsage = {
			totalCost: 0.5,
			totalTokensIn: 1_000,
			totalTokensOut: 2_000,
			contextTokens: 5_000,
		} as TokenUsage

		const { lastFrame } = renderHeader({ tokenUsage, contextWindow: 10_000 })
		const output = lastFrame()

		expect(output).toContain("$0.50")
		expect(output).toContain("50%")
	})

	it("omits the metrics strip without token usage", () => {
		const { lastFrame } = renderHeader({ contextWindow: 10_000 })
		expect(lastFrame()).not.toContain("$")
	})

	it("omits the metrics strip when the context window is zero", () => {
		const tokenUsage = {
			totalCost: 0.5,
			totalTokensIn: 1,
			totalTokensOut: 1,
			contextTokens: 1,
		} as TokenUsage

		const { lastFrame } = renderHeader({ tokenUsage, contextWindow: 0 })
		expect(lastFrame()).not.toContain("$0.50")
	})

	it("clamps the trailing rule when the title exceeds the terminal width", () => {
		Object.defineProperty(process.stdout, "columns", { value: 8, configurable: true })
		const { lastFrame } = renderHeader({ version: "10.20.30-with-a-long-suffix" })

		// `remainingDashes` would go negative here; `Math.max(0, …)` keeps
		// String.repeat from throwing, so the frame still renders.
		expect(lastFrame()).toContain("mode:")
	})
})
