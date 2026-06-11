/**
 * Webview spec for LauncherView workflow-card rendering with expanded metadata.
 *
 * Vitest globals (describe/it/expect/vi) are available globally per the Test
 * Layout Rule in AGENTS.md. Naming convention: *.spec.tsx (jsdom env).
 */

import React from "react"
import { render, screen, act, cleanup } from "@/utils/test-utils"

import { LauncherView } from "../LauncherView"

// ── Mocks ──

const { mockPostMessage } = vi.hoisted(() => ({ mockPostMessage: vi.fn() }))
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: mockPostMessage,
	},
}))

// LauncherView renders Tab/TabContent, which call useExtensionState().renderContext.
// The shared test-utils render wrapper does not provide ExtensionStateContextProvider,
// so stub the hook (matching the pattern in MarkdownBlock.spec.tsx).
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ renderContext: "sidebar" }),
}))

// Mock TranslationProvider to pass through children
const tFunction = (key: string, options?: Record<string, any>) => {
	if (options?.count !== undefined) {
		return key.replace("{{count}}", String(options.count))
	}
	return key
}

vi.mock("@src/i18n/TranslationContext", () => ({
	__esModule: true,
	default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	useAppTranslation: () => ({
		t: tFunction,
		i18n: {
			t: tFunction,
			changeLanguage: vi.fn(() => Promise.resolve()),
		},
	}),
}))

// ── Test helpers ──

const MODES = [
	{ slug: "code", name: "Code", description: "Write and modify code" },
	{ slug: "architect", name: "Architect", description: "Design and plan" },
]

const WORKFLOW_FULL_METADATA = {
	name: "hello-world",
	title: "Hello World",
	description: "Simplest possible workflow.",
	icon: "rocket",
	agents: ["Greeter"],
	params: [{ name: "name", type: "string", description: "The name of the person to greet." }],
}

const WORKFLOW_MINIMAL = {
	name: "minimal",
	title: "minimal",
	description: "",
	icon: undefined,
	agents: [],
	params: [],
}

const WORKFLOW_MULTI_AGENT = {
	name: "multi",
	title: "Multi-Agent Pipeline",
	description: "A workflow with three agents collaborating.",
	icon: "code",
	agents: ["Planner", "Builder", "Tester"],
	params: [],
}

/** Override the canned workflow response by dispatching a fake `workflowsList` message. */
function dispatchWorkflows(workflows: any[]) {
	// Dispatch a synchronous MessageEvent (not window.postMessage, whose delivery is
	// a macrotask that a synchronous act() won't flush) so the component's message
	// listener fires before assertions. Matches the codebase pattern (App.spec.tsx).
	window.dispatchEvent(new MessageEvent("message", { data: { type: "workflowsList", workflows } }))
}

// ── Tests ──

describe("LauncherView workflow cards", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		cleanup()
	})

	it("shows loading state when workflows have not loaded yet", () => {
		render(<LauncherView modes={MODES} initialStage="workflow" onClose={vi.fn()} />)
		expect(screen.getByText("launcher:newWorkflow.loading")).toBeInTheDocument()
	})

	it("shows empty state when no workflows are discovered", () => {
		render(<LauncherView modes={MODES} initialStage="workflow" onClose={vi.fn()} />)
		act(() => {
			dispatchWorkflows([])
		})
		expect(screen.getByText("launcher:newWorkflow.empty")).toBeInTheDocument()
	})

	it("renders a workflow card with full metadata (title, icon, agent count, param descriptions)", () => {
		render(<LauncherView modes={MODES} initialStage="workflow" onClose={vi.fn()} />)
		act(() => {
			dispatchWorkflows([WORKFLOW_FULL_METADATA])
		})

		// Title from flow.title, not flow.name
		expect(screen.getByText("Hello World")).toBeInTheDocument()

		// Machine name is in the subtitle
		expect(screen.getByText(/hello-world/)).toBeInTheDocument()

		// Agent count badge
		expect(screen.getByText(/launcher:newWorkflow.agentsCount/)).toBeInTheDocument()

		// Params count badge
		expect(screen.getByText(/launcher:newWorkflow.paramsCount/)).toBeInTheDocument()

		// Param with description (appears in the body)
		expect(screen.getByText(/name: string — The name of the person to greet\./)).toBeInTheDocument()
	})

	it("falls back gracefully for a minimal workflow with no metadata", () => {
		render(<LauncherView modes={MODES} initialStage="workflow" onClose={vi.fn()} />)
		act(() => {
			dispatchWorkflows([WORKFLOW_MINIMAL])
		})

		// Title falls back to name
		expect(screen.getByText("minimal")).toBeInTheDocument()

		// No agents badge (shows "No agents") — embedded in the card subtitle, so match as substring
		expect(screen.getByText(/launcher:newWorkflow\.noAgents/)).toBeInTheDocument()

		// No params subtitle
		expect(screen.queryByText(/launcher:newWorkflow.paramsCount/)).not.toBeInTheDocument()
	})

	it("renders a multi-agent workflow with correct agent count", () => {
		render(<LauncherView modes={MODES} initialStage="workflow" onClose={vi.fn()} />)
		act(() => {
			dispatchWorkflows([WORKFLOW_MULTI_AGENT])
		})

		expect(screen.getByText("Multi-Agent Pipeline")).toBeInTheDocument()
		// 3 agents — plural
		expect(screen.getByText(/launcher:newWorkflow.agentsCount_plural/)).toBeInTheDocument()
	})

	it("clicking a workflow card sends createWorkflow with flow.name", () => {
		render(<LauncherView modes={MODES} initialStage="workflow" onClose={vi.fn()} />)
		act(() => {
			dispatchWorkflows([WORKFLOW_FULL_METADATA])
		})

		// Click the card (by title)
		const card = screen.getByText("Hello World").closest("button")!
		act(() => {
			card.click()
		})

		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "createWorkflow",
				flowName: "hello-world", // machine identifier, not title
			}),
		)
	})

	it("shows mode cards when initialStage is task", () => {
		render(<LauncherView modes={MODES} initialStage="task" onClose={vi.fn()} />)
		expect(screen.getByText("Code")).toBeInTheDocument()
		expect(screen.getByText("Architect")).toBeInTheDocument()
	})

	it("clicking a mode card sends launchTask with the mode slug", () => {
		render(<LauncherView modes={MODES} initialStage="task" onClose={vi.fn()} />)
		const card = screen.getByText("Code").closest("button")!
		act(() => {
			card.click()
		})
		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "launchTask",
				mode: "code",
			}),
		)
	})
})
