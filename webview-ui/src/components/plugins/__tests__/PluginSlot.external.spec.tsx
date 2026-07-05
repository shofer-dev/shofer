// npm run test PluginSlot.external.spec.tsx
//
// Proves PluginSlot loads a THIRD-PARTY plugin's own **built** UI bundle (P4) via
// its served `source` URI — dynamic import of an external module, not the co-bundled
// registry — that the scoped channel round-trips to that external component, and
// that a crashing external bundle is isolated. See ./fixtures/* for the built bundles.

import { resolve } from "node:path"

import { render, screen, waitFor, fireEvent } from "@/utils/test-utils"

import type { PluginUiContribution } from "@shofer/types"

import { PluginSlotView } from "../PluginSlot"

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))
import { vscode } from "@src/utils/vscode"

const task = { taskId: "t1", mode: "code" }

// Absolute paths to the fixtures' built UI bundles (the served `source` stand-in).
// Tests run with cwd = webview-ui; the resolver dynamic-imports these paths.
const fixtures = resolve(process.cwd(), "src/components/plugins/__tests__/fixtures")
const toolbarSource = resolve(fixtures, "plugin-fixture/ui/toolbar.js")
const crashSource = resolve(fixtures, "plugin-fixture-crash/ui/boom.js")

/** A contribution that loads an external bundle from `source` (no co-bundled entry). */
function external(pluginName: string, source: string): PluginUiContribution {
	return { pluginName, region: "task-header", componentId: `${pluginName}:task-header`, source }
}

/** Simulate the extension posting a scoped inbound message into the webview. */
function dispatchFromExtension(pluginName: string, message: unknown) {
	window.dispatchEvent(
		new MessageEvent("message", { data: { type: "pluginUiMessage", pluginUiMessage: { pluginName, message } } }),
	)
}

describe("PluginSlot — external plugin UI bundle (design §6.8, P4)", () => {
	afterEach(() => {
		vi.mocked(vscode.postMessage).mockClear()
		vi.restoreAllMocks()
	})

	it("loads + renders a plugin's own built bundle via its served source URI", async () => {
		render(<PluginSlotView region="task-header" contributions={[external("fixture-ui", toolbarSource)]} task={task} />)
		// The external component mounted and received its scoped, read-only context.
		expect(await screen.findByTestId("ext-toolbar")).toBeInTheDocument()
		expect(screen.getByTestId("ext-where")).toHaveTextContent("task-header")
	})

	it("round-trips the scoped channel to the external component (out + in)", async () => {
		render(<PluginSlotView region="task-header" contributions={[external("fixture-ui", toolbarSource)]} task={task} />)
		await screen.findByTestId("ext-toolbar")

		// Outbound: the external component posts through its scoped api → tagged envelope.
		fireEvent.click(screen.getByTestId("ext-send"))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "pluginUiMessage",
			pluginUiMessage: { pluginName: "fixture-ui", message: { hello: "task-header" } },
		})

		// Inbound: an extension → UI reply addressed to this plugin is delivered + rendered.
		dispatchFromExtension("fixture-ui", "pong")
		await waitFor(() => expect(screen.getByTestId("ext-reply")).toHaveTextContent("pong"))

		// Namespacing: a message for another plugin must not reach this component.
		dispatchFromExtension("other", "nope")
		expect(screen.getByTestId("ext-reply")).toHaveTextContent("pong")
	})

	it("isolates a crashing external bundle — host survives, nothing leaks", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		render(
			<div>
				<span data-testid="host">host content</span>
				<PluginSlotView region="task-header" contributions={[external("boom", crashSource)]} task={task} />
			</div>,
		)
		expect(screen.getByTestId("host")).toBeInTheDocument()
		await waitFor(() => expect(warn).toHaveBeenCalled())
		expect(screen.queryByText("boom from external plugin UI")).not.toBeInTheDocument()
		// Host sibling is untouched.
		expect(screen.getByTestId("host")).toBeInTheDocument()
	})
})
