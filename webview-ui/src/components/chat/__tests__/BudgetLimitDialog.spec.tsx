// npx vitest src/components/chat/__tests__/BudgetLimitDialog.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import { BudgetLimitDialog } from "../BudgetLimitDialog"

const onSave = vi.fn()

beforeEach(() => vi.clearAllMocks())

const openPopover = (container: HTMLElement) => fireEvent.click(container.querySelector("button")!)

describe("BudgetLimitDialog", () => {
	it("offers the wallet affordance with no limit set, and the pencil once there is one", () => {
		const { container, rerender } = render(<BudgetLimitDialog spent={0} onSave={onSave} />)
		expect(container.querySelector(".lucide-wallet")).toBeTruthy()

		rerender(<BudgetLimitDialog costLimit={{ maxUsd: 10, action: "abort" }} spent={0} onSave={onSave} />)
		expect(container.querySelector(".lucide-pencil")).toBeTruthy()
	})

	it("opens with the $5 / pause defaults when nothing is set", () => {
		const { container } = render(<BudgetLimitDialog spent={0} onSave={onSave} />)
		openPopover(container)

		expect(screen.getByRole("spinbutton")).toHaveValue(5)
		expect(screen.getByRole("combobox")).toHaveValue("pause")
	})

	it("pre-fills the existing limit and its action", () => {
		const { container } = render(
			<BudgetLimitDialog costLimit={{ maxUsd: 12.5, action: "kill" }} spent={1} onSave={onSave} />,
		)
		openPopover(container)
		expect(screen.getByRole("spinbutton")).toHaveValue(12.5)
		expect(screen.getByRole("combobox")).toHaveValue("kill")
	})

	it("re-syncs when the parent hands it a different limit", () => {
		const { container, rerender } = render(
			<BudgetLimitDialog costLimit={{ maxUsd: 1, action: "pause" }} spent={0} onSave={onSave} />,
		)
		rerender(<BudgetLimitDialog costLimit={{ maxUsd: 99, action: "abort" }} spent={0} onSave={onSave} />)
		openPopover(container)
		expect(screen.getByRole("spinbutton")).toHaveValue(99)
	})

	it("saves the edited limit and closes", () => {
		const { container } = render(<BudgetLimitDialog spent={0} onSave={onSave} />)
		openPopover(container)

		fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "20" } })
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "abort" } })
		fireEvent.click(screen.getByText("Save"))

		expect(onSave).toHaveBeenCalledWith({ maxUsd: 20, action: "abort" })
		expect(screen.queryByText("Save")).not.toBeInTheDocument()
	})

	it("refuses a non-positive or unparseable limit and stays open", () => {
		const { container } = render(<BudgetLimitDialog spent={0} onSave={onSave} />)
		openPopover(container)

		fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0" } })
		fireEvent.click(screen.getByText("Save"))
		expect(onSave).not.toHaveBeenCalled()

		fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "" } })
		fireEvent.click(screen.getByText("Save"))
		expect(onSave).not.toHaveBeenCalled()
		expect(screen.getByText("Save")).toBeInTheDocument()
	})

	it("saves on Enter and closes on Escape", () => {
		const { container } = render(<BudgetLimitDialog spent={0} onSave={onSave} />)
		openPopover(container)

		fireEvent.keyDown(screen.getByRole("spinbutton"), { key: "Enter" })
		expect(onSave).toHaveBeenCalledWith({ maxUsd: 5, action: "pause" })

		openPopover(container)
		fireEvent.keyDown(screen.getByRole("spinbutton"), { key: "Escape" })
		expect(screen.queryByText("Save")).not.toBeInTheDocument()
	})

	it("dismisses from Cancel without saving", () => {
		const { container } = render(<BudgetLimitDialog spent={0} onSave={onSave} />)
		openPopover(container)
		fireEvent.click(screen.getByText("Cancel"))
		expect(onSave).not.toHaveBeenCalled()
		expect(screen.queryByText("Save")).not.toBeInTheDocument()
	})

	it("flags an already-overspent root", () => {
		const { container } = render(
			<BudgetLimitDialog costLimit={{ maxUsd: 5, action: "pause" }} spent={7.5} onSave={onSave} />,
		)
		expect(container.querySelector(".text-red-400")).toBeTruthy()

		openPopover(container)
		expect(screen.getByText("Spent $7.50 — already over limit")).toBeInTheDocument()
	})

	it("does not flag a root under its limit", () => {
		const { container } = render(
			<BudgetLimitDialog costLimit={{ maxUsd: 5, action: "pause" }} spent={1} onSave={onSave} />,
		)
		openPopover(container)
		expect(screen.queryByText(/already over limit/)).not.toBeInTheDocument()
	})
})
