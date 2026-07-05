// npm run test PluginSlot.spec.tsx

import { render, screen, waitFor } from "@/utils/test-utils"

import type { PluginUIApi, PluginUiContribution } from "@shofer/types"

import { PluginSlotView } from "../PluginSlot"
import { registerPluginComponent, unregisterPluginComponent } from "../pluginComponentResolver"

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

const task = { taskId: "t1", mode: "code" }

function contribution(pluginName: string, region: PluginUiContribution["region"]): PluginUiContribution {
	return { pluginName, region, componentId: `${pluginName}:${region}` }
}

describe("PluginSlot (design §6.8, Phase 4)", () => {
	afterEach(() => {
		unregisterPluginComponent("good:task-header")
		unregisterPluginComponent("bad:task-header")
		vi.restoreAllMocks()
	})

	it("renders nothing when there are no contributions (non-breaking)", () => {
		const { container } = render(<PluginSlotView region="task-header" contributions={[]} task={task} />)
		expect(container).toBeEmptyDOMElement()
	})

	it("resolves + renders a co-bundled fixture component with its scoped api/context", async () => {
		registerPluginComponent("good:task-header", ({ api }: { api: PluginUIApi }) => (
			<div data-testid="good">
				hi from {api.context.pluginName} in {api.context.region} (task {api.context.task?.taskId})
			</div>
		))
		render(<PluginSlotView region="task-header" contributions={[contribution("good", "task-header")]} task={task} />)
		expect(await screen.findByTestId("good")).toHaveTextContent("hi from good in task-header (task t1)")
	})

	it("isolates a throwing plugin component — renders nothing, host survives", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		registerPluginComponent("bad:task-header", () => {
			throw new Error("plugin boom")
		})
		render(
			<div>
				<span data-testid="host">host content</span>
				<PluginSlotView region="task-header" contributions={[contribution("bad", "task-header")]} task={task} />
			</div>,
		)
		// The host stays mounted; the crashing plugin renders nothing.
		expect(screen.getByTestId("host")).toBeInTheDocument()
		await waitFor(() => expect(warn).toHaveBeenCalled())
		expect(screen.queryByText("plugin boom")).not.toBeInTheDocument()
	})

	it("renders nothing for an unknown/unresolvable componentId", async () => {
		const { container } = render(
			<PluginSlotView region="task-header" contributions={[contribution("missing", "task-header")]} task={task} />,
		)
		// Nothing resolves → nothing rendered; host is unaffected.
		await waitFor(() => expect(container).toBeEmptyDOMElement())
	})
})
