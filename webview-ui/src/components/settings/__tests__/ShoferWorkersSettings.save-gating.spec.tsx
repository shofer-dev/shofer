// npx vitest src/components/settings/__tests__/ShoferWorkersSettings.save-gating.spec.tsx

import { createRef } from "react"
import { render, screen, fireEvent, waitFor } from "@/utils/test-utils"

import { ExtensionStateContext } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import { ShoferWorkersSettings, type ShoferWorkersSettingsRef } from "../ShoferWorkersSettings"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const worker = {
	id: "remote-1",
	kind: "remote" as const,
	label: "build-box",
	host: "127.0.0.1:30099",
	status: "connected" as const,
	disabled: false,
}

const renderNodes = (ref: React.Ref<ShoferWorkersSettingsRef>, shoferWorkers: Record<string, unknown> = {}) =>
	render(
		<ExtensionStateContext.Provider
			value={{ shoferWorkers: { workers: [worker], loadBalancer: "round-robin", ...shoferWorkers } } as any}>
			<ShoferWorkersSettings ref={ref} />
		</ExtensionStateContext.Provider>,
	)

describe("ShoferWorkersSettings save-gating", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("stages the disable toggle and only persists on commitNodeBuffers", async () => {
		const ref = createRef<ShoferWorkersSettingsRef>()
		renderNodes(ref)

		const toggle = await waitFor(() => screen.getByTitle("Disable (remove from pool)"))
		fireEvent.click(toggle)

		// Clicking must NOT post — the change is staged until Save.
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ shoferWorker: expect.objectContaining({ action: "setDisabled" }) }),
		)
		// …but it renders immediately (staged-first): the button flips to "Enable".
		await waitFor(() => expect(screen.getByTitle("Enable (return to pool)")).toBeInTheDocument())

		ref.current?.commitNodeBuffers()

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "shoferWorker",
			shoferWorker: { action: "setDisabled", id: "remote-1", disabled: true },
		})
	})

	it("drops a staged disable toggle on discardNodeBuffers", async () => {
		const ref = createRef<ShoferWorkersSettingsRef>()
		renderNodes(ref)

		fireEvent.click(await waitFor(() => screen.getByTitle("Disable (remove from pool)")))
		await waitFor(() => expect(screen.getByTitle("Enable (return to pool)")).toBeInTheDocument())

		ref.current?.discardNodeBuffers()

		// Reverts to the live value, and nothing was persisted.
		await waitFor(() => expect(screen.getByTitle("Disable (remove from pool)")).toBeInTheDocument())
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ shoferWorker: expect.objectContaining({ action: "setDisabled" }) }),
		)
	})

	it("does not re-post a staged value that already matches the live one", async () => {
		const ref = createRef<ShoferWorkersSettingsRef>()
		renderNodes(ref)

		// Toggle twice: staged value returns to the live value.
		fireEvent.click(await waitFor(() => screen.getByTitle("Disable (remove from pool)")))
		fireEvent.click(await waitFor(() => screen.getByTitle("Enable (return to pool)")))

		ref.current?.commitNodeBuffers()

		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ shoferWorker: expect.objectContaining({ action: "setDisabled" }) }),
		)
	})
})
