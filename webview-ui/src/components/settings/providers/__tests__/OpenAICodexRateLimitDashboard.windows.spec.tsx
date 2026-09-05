// npx vitest src/components/settings/providers/__tests__/OpenAICodexRateLimitDashboard.windows.spec.tsx
//
// The Codex rate-limit panel is mostly formatting: a window length in minutes
// becomes a named window ("weekly") or a derived one ("N hours"), and a reset
// timestamp becomes a human duration. Each branch is walked, plus the
// loading/error states the host can put it in.

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import { OpenAICodexRateLimitDashboard } from "../OpenAICodexRateLimitDashboard"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}(${Object.values(opts).join(",")})` : key),
	}),
}))

const posted = (type: string) => postMessage.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === type)

const answer = (payload: Record<string, unknown>) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "openAiCodexRateLimits", ...payload } }))
	})

const HOUR = 60 * 60 * 1000

beforeEach(() => vi.clearAllMocks())

describe("authentication gating", () => {
	it("renders nothing and asks nothing while signed out", () => {
		const { container } = render(<OpenAICodexRateLimitDashboard isAuthenticated={false} />)
		expect(container).toBeEmptyDOMElement()
		expect(posted("requestOpenAiCodexRateLimits")).toHaveLength(0)
	})

	it("asks for the limits as soon as it is signed in", () => {
		render(<OpenAICodexRateLimitDashboard isAuthenticated />)
		expect(posted("requestOpenAiCodexRateLimits")).toHaveLength(1)
		expect(screen.getByText("settings:providers.openAiCodexRateLimits.loading")).toBeInTheDocument()
	})
})

describe("failure", () => {
	it("shows the host's reason and offers a retry", () => {
		render(<OpenAICodexRateLimitDashboard isAuthenticated />)
		answer({ error: "token expired" })

		expect(screen.getByText("settings:providers.openAiCodexRateLimits.loadError")).toBeInTheDocument()
		expect(screen.getByText("token expired")).toBeInTheDocument()

		fireEvent.click(screen.getByText("settings:providers.openAiCodexRateLimits.retry"))
		expect(posted("requestOpenAiCodexRateLimits")).toHaveLength(2)
	})

	it("renders nothing at all when the host answers with no values", () => {
		const { container } = render(<OpenAICodexRateLimitDashboard isAuthenticated />)
		answer({})
		expect(container).toBeEmptyDOMElement()
	})
})

describe("window naming", () => {
	const withWindow = (windowMinutes: number) => {
		render(<OpenAICodexRateLimitDashboard isAuthenticated />)
		answer({ values: { primary: { usedPercent: 10, windowMinutes } } })
	}

	it.each([
		[60, "window.oneHour"],
		[24 * 60, "window.daily"],
		[7 * 24 * 60, "window.weekly"],
		[5 * 60, "window.fiveHour"],
	])("names the %i-minute window", (minutes, key) => {
		withWindow(minutes)
		expect(screen.getByText(new RegExp(key.replace(".", "\\.")))).toBeInTheDocument()
	})

	it("derives a whole-day window it has no name for", () => {
		withWindow(3 * 24 * 60)
		expect(screen.getByText(/window\.days\(3\)/)).toBeInTheDocument()
	})

	it("derives a whole-hour window it has no name for", () => {
		withWindow(3 * 60)
		expect(screen.getByText(/window\.hours\(3\)/)).toBeInTheDocument()
	})

	it("falls back to minutes for anything else", () => {
		withWindow(90)
		expect(screen.getByText(/window\.minutes\(90\)/)).toBeInTheDocument()
	})

	it("labels a window-less limit generically", () => {
		render(<OpenAICodexRateLimitDashboard isAuthenticated />)
		answer({ values: { primary: { usedPercent: 10 } } })
		expect(screen.getByText("settings:providers.openAiCodexRateLimits.window.usage")).toBeInTheDocument()
	})
})

describe("reset-time formatting", () => {
	const withReset = (resetsAt: number) => {
		render(<OpenAICodexRateLimitDashboard isAuthenticated />)
		answer({ values: { primary: { usedPercent: 50, windowMinutes: 60, resetsAt } } })
	}

	it("counts days and hours for a distant reset", () => {
		withReset(Date.now() + 50 * HOUR)
		expect(screen.getByText(/duration\.daysHours/)).toBeInTheDocument()
	})

	it("counts hours and minutes within a day", () => {
		withReset(Date.now() + 3 * HOUR)
		expect(screen.getByText(/duration\.hoursMinutes/)).toBeInTheDocument()
	})

	it("counts minutes within an hour", () => {
		withReset(Date.now() + 10 * 60 * 1000)
		expect(screen.getByText(/duration\.minutes/)).toBeInTheDocument()
	})

	it("says 'now' for a reset already due", () => {
		withReset(Date.now() - 1000)
		expect(screen.getByText(/time\.now/)).toBeInTheDocument()
	})
})

describe("the usage bars", () => {
	it("renders both windows with their own bars", () => {
		const { container } = render(<OpenAICodexRateLimitDashboard isAuthenticated />)
		answer({
			values: {
				planType: "pro",
				primary: { usedPercent: 30, windowMinutes: 60 },
				secondary: { usedPercent: 95, windowMinutes: 7 * 24 * 60 },
			},
		})

		expect(screen.getByText(/plan\.withType\(pro\)/)).toBeInTheDocument()
		expect(container.querySelectorAll('[style*="width"]')).toHaveLength(2)
	})

	it("names the default plan when the host reports none", () => {
		render(<OpenAICodexRateLimitDashboard isAuthenticated />)
		answer({ values: { primary: { usedPercent: 1, windowMinutes: 60 } } })
		expect(screen.getByText(/plan\.default/)).toBeInTheDocument()
	})

	it("clamps an out-of-range percentage into the bar", () => {
		const { container } = render(<OpenAICodexRateLimitDashboard isAuthenticated />)
		answer({ values: { primary: { usedPercent: 250, windowMinutes: 60 } } })
		expect(container.querySelector('[style*="width: 100%"]')).toBeTruthy()
	})

	it("colours a critical window differently from a healthy one", () => {
		const { container } = render(<OpenAICodexRateLimitDashboard isAuthenticated />)
		answer({
			values: {
				primary: { usedPercent: 10, windowMinutes: 60 },
				secondary: { usedPercent: 95, windowMinutes: 60 },
			},
		})
		expect(container.querySelector(".bg-vscode-button-background")).toBeTruthy()
		expect(container.querySelector(".bg-vscode-errorForeground")).toBeTruthy()
	})

	it("colours a warning window between the two", () => {
		const { container } = render(<OpenAICodexRateLimitDashboard isAuthenticated />)
		answer({ values: { primary: { usedPercent: 75, windowMinutes: 60 } } })
		expect(container.querySelector(".bg-vscode-editorWarning-foreground")).toBeTruthy()
	})
})
