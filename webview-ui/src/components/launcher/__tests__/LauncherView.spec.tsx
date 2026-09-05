// npx vitest src/components/launcher/__tests__/LauncherView.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import { LauncherView } from "../LauncherView"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const setMode = vi.fn()
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ setMode }),
}))

const onClose = vi.fn()

beforeEach(() => vi.clearAllMocks())

describe("LauncherView", () => {
	it("says so when there is no mode to offer", () => {
		render(<LauncherView modes={[]} onClose={onClose} />)
		expect(screen.getByText("launcher:newTask.empty")).toBeInTheDocument()
	})

	it("renders one card per mode, with its description when it has one", () => {
		render(
			<LauncherView
				modes={[
					{ slug: "code", name: "Code", description: "write software" },
					{ slug: "ask", name: "Ask" },
				]}
				onClose={onClose}
			/>,
		)
		expect(screen.getByText("Code")).toBeInTheDocument()
		expect(screen.getByText("write software")).toBeInTheDocument()
		expect(screen.getByText("Ask")).toBeInTheDocument()
	})

	it("seeds the shared mode draft BEFORE launching, then closes", () => {
		const order: string[] = []
		setMode.mockImplementation(() => order.push("setMode"))
		postMessage.mockImplementation(() => order.push("launchTask"))
		onClose.mockImplementation(() => order.push("close"))

		render(<LauncherView modes={[{ slug: "code", name: "Code" }]} onClose={onClose} />)
		fireEvent.click(screen.getByText("Code"))

		expect(setMode).toHaveBeenCalledWith("code")
		expect(postMessage).toHaveBeenCalledWith({ type: "launchTask", mode: "code" })
		expect(order).toEqual(["setMode", "launchTask", "close"])
	})

	it("dismisses from the header close button", () => {
		render(<LauncherView modes={[]} onClose={onClose} />)
		fireEvent.click(screen.getByLabelText("launcher:close"))
		expect(onClose).toHaveBeenCalled()
		expect(postMessage).not.toHaveBeenCalled()
	})
})
