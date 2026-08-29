// npm run test LiveMemoryPanel.external.spec.tsx
//
// Stage-E: renders the Live Memory plugin's OWN built `sidebar-panel` UI bundle
// (plugins/live-memory/ui/panel.js) through PluginSlot's external-bundle path — the
// same harness as PluginSlot.external.spec.tsx — and drives it with a streaming state
// sequence over the scoped plugin-UI channel. Asserts: the panel loads + requests its
// initial state on mount; typed parts (text / reasoning / tool_call) render; a
// tool_call transitions spinner(running) → done; and the clear/empty commands round-trip
// back out over the (namespaced) channel.

import { resolve, dirname } from "node:path"
import { mkdirSync, copyFileSync, rmSync } from "node:fs"

import { render, screen, waitFor, fireEvent } from "@/utils/test-utils"

import type { PluginUiContribution } from "@shofer/types"

import { PluginSlotView } from "../PluginSlot"

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))
import { vscode } from "@src/utils/vscode"

const PLUGIN = "live-memory"
const task = { taskId: "t1", mode: "code" }

// The plugin's REAL built UI bundle (the shipped `contributes.ui` entry). Tests run
// with cwd = webview-ui; the bundle lives in the sibling plugins/ dir.
const builtBundle = resolve(process.cwd(), "../plugins/live-memory/ui/panel.js")
// Vite resolves a bundle's bare `react` import relative to the module's own location,
// so — exactly like the sibling plugin-fixture bundles — the external module must sit
// INSIDE webview-ui to reach its node_modules/react. Copy the real built bytes to a
// temp path under webview-ui and load THAT (same shipped bundle, resolvable React).
const panelSource = resolve(process.cwd(), "src/components/plugins/__tests__/fixtures/.generated/live-memory/panel.js")

beforeAll(() => {
	mkdirSync(dirname(panelSource), { recursive: true })
	copyFileSync(builtBundle, panelSource)
})
afterAll(() => {
	rmSync(resolve(process.cwd(), "src/components/plugins/__tests__/fixtures/.generated"), {
		recursive: true,
		force: true,
	})
})

function contribution(): PluginUiContribution {
	return { pluginName: PLUGIN, region: "sidebar-panel", componentId: `${PLUGIN}:sidebar-panel`, source: panelSource }
}

/** Simulate the plugin (extension side) pushing a scoped message into the panel. */
function pushFromPlugin(message: unknown, pluginName = PLUGIN) {
	window.dispatchEvent(
		new MessageEvent("message", { data: { type: "pluginUiMessage", pluginUiMessage: { pluginName, message } } }),
	)
}

function stateMsg(over: Partial<Record<string, unknown>> = {}) {
	return {
		type: "state",
		state: "Ready",
		stateMessage: "Agent is ready",
		contextUsage: { currentTokens: 1200, maxTokens: 128000, fillFraction: 0.0094, isNearlyFull: false },
		messages: [],
		stats: { observations: 3, questions: 1, pendingQuestions: 0 },
		...over,
	}
}

/**
 * Mount the panel and wait for its `ready` handshake. The panel subscribes to the
 * scoped channel in a mount effect and posts `ready` from that same effect; the DOM
 * node appears at commit, BEFORE that passive effect runs, so a state message pushed
 * on `findByTestId` alone races the subscription and is silently dropped under
 * full-suite load. `ready` is exactly the signal the extension side waits for before
 * it sends state, so the test honours the same handshake.
 */
async function mountPanel() {
	render(<PluginSlotView region="sidebar-panel" contributions={[contribution()]} task={task} />)
	await screen.findByTestId("lm-panel")
	await waitFor(() =>
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "pluginUiMessage",
			pluginUiMessage: { pluginName: PLUGIN, message: { type: "ready" } },
		}),
	)
}

const assistantWith = (toolInProgress: boolean) => ({
	id: "a1",
	role: "assistant",
	content: "",
	timestamp: 0,
	parts: [
		{ kind: "reasoning", text: "Let me look at the entrypoint." },
		{ kind: "text", text: "# Findings\nThe entry is **main.ts**." },
		{
			kind: "tool_call",
			toolCallId: "tc1",
			name: "read_file",
			args: '{"path":"main.ts"}',
			inProgress: toolInProgress,
			...(toolInProgress ? {} : { result: "export default plugin", isError: false }),
		},
	],
})

describe("LiveMemoryPanel — external sidebar-panel bundle (Stage E)", () => {
	afterEach(() => {
		vi.mocked(vscode.postMessage).mockClear()
		vi.restoreAllMocks()
	})

	it("loads the built bundle and requests initial state on mount", async () => {
		// mountPanel asserts both halves: the bundle rendered and posted { type: "ready" }.
		await mountPanel()
		expect(screen.getByTestId("lm-panel")).toBeInTheDocument()
	})

	it("renders the state header + streamed typed parts, and transitions spinner → done", async () => {
		await mountPanel()

		// ── Busy turn: reasoning + markdown text + an in-progress tool call ──
		pushFromPlugin(stateMsg({ state: "Busy", stateMessage: "Processing…", messages: [assistantWith(true)] }))

		await waitFor(() => expect(screen.getByTestId("lm-state")).toHaveTextContent("State: Busy"))
		// reasoning part
		expect(screen.getByText("Thinking")).toBeInTheDocument()
		expect(screen.getByText("Let me look at the entrypoint.")).toBeInTheDocument()
		// text part rendered as markdown (heading + bold)
		expect(screen.getByText("Findings")).toBeInTheDocument()
		expect(screen.getByText("main.ts")).toBeInTheDocument()
		// tool_call part in-progress: spinner shown, status "running"
		expect(screen.getByTestId("tool-part")).toBeInTheDocument()
		expect(screen.getByTestId("tool-spinner")).toBeInTheDocument()
		expect(screen.getByTestId("tool-status")).toHaveTextContent("running")
		expect(screen.getByText("read_file")).toBeInTheDocument()

		// ── Ready turn: same tool call now completed ──
		pushFromPlugin(stateMsg({ state: "Ready", messages: [assistantWith(false)] }))

		await waitFor(() => expect(screen.getByTestId("tool-status")).toHaveTextContent("done"))
		expect(screen.queryByTestId("tool-spinner")).not.toBeInTheDocument()
		expect(screen.getByText("export default plugin")).toBeInTheDocument()
		expect(screen.getByTestId("lm-state")).toHaveTextContent("State: Ready")
	})

	it("round-trips clear + empty commands out over the scoped channel", async () => {
		await mountPanel()
		vi.mocked(vscode.postMessage).mockClear() // drop the mount "ready"

		fireEvent.click(screen.getByTestId("lm-clear"))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "pluginUiMessage",
			pluginUiMessage: { pluginName: PLUGIN, message: { type: "clear" } },
		})

		fireEvent.click(screen.getByTestId("lm-empty"))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "pluginUiMessage",
			pluginUiMessage: { pluginName: PLUGIN, message: { type: "empty" } },
		})
	})

	it("ignores a state message addressed to another plugin (channel namespacing)", async () => {
		await mountPanel()

		pushFromPlugin(stateMsg({ state: "Error", messages: [assistantWith(false)] }), "other-plugin")
		// The panel stayed on its initial Standby state — the foreign message never reached it.
		expect(screen.getByTestId("lm-state")).toHaveTextContent("State: Standby")
	})
})
