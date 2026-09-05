// npx vitest src/components/tasks/__tests__/TaskNotification.spec.tsx

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import { TaskNotification, TaskNotificationContainer, type TaskNotification as Notification } from "../TaskNotification"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}))

const onDismiss = vi.fn()
const onFocus = vi.fn()

const notification = (over: Partial<Notification> = {}): Notification => ({
	taskId: "t1",
	type: "needs_input",
	message: "waiting on you",
	timestamp: 1,
	...over,
})

beforeEach(() => vi.clearAllMocks())

describe("TaskNotification", () => {
	it("shows the task name and the message", () => {
		render(
			<TaskNotification
				notification={notification()}
				taskName="Refactor the parser"
				onDismiss={onDismiss}
				onFocus={onFocus}
			/>,
		)
		expect(screen.getByText("Refactor the parser")).toBeInTheDocument()
		expect(screen.getByText("waiting on you")).toBeInTheDocument()
	})

	it("offers Switch only for a notification that needs the user", () => {
		const { rerender } = render(
			<TaskNotification notification={notification()} taskName="t" onDismiss={onDismiss} onFocus={onFocus} />,
		)
		expect(screen.getByText("Switch")).toBeInTheDocument()

		rerender(
			<TaskNotification
				notification={notification({ type: "completed" })}
				taskName="t"
				onDismiss={onDismiss}
				onFocus={onFocus}
			/>,
		)
		expect(screen.queryByText("Switch")).not.toBeInTheDocument()
	})

	it("focuses the task and hides itself", () => {
		const { container } = render(
			<TaskNotification notification={notification()} taskName="t" onDismiss={onDismiss} onFocus={onFocus} />,
		)
		fireEvent.click(screen.getByText("Switch"))
		expect(onFocus).toHaveBeenCalledWith("t1")
		expect(container).toBeEmptyDOMElement()
	})

	it("dismisses on the close button", () => {
		const { container } = render(
			<TaskNotification notification={notification()} taskName="t" onDismiss={onDismiss} onFocus={onFocus} />,
		)
		fireEvent.click(screen.getByLabelText("Dismiss"))
		expect(onDismiss).toHaveBeenCalledWith("t1")
		expect(container).toBeEmptyDOMElement()
	})

	it("auto-dismisses a non-interactive notification after thirty seconds", () => {
		vi.useFakeTimers()
		const { container } = render(
			<TaskNotification
				notification={notification({ type: "completed" })}
				taskName="t"
				onDismiss={onDismiss}
				onFocus={onFocus}
			/>,
		)

		act(() => {
			vi.advanceTimersByTime(29_000)
		})
		expect(onDismiss).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(2_000)
		})
		expect(onDismiss).toHaveBeenCalledWith("t1")
		expect(container).toBeEmptyDOMElement()
		vi.useRealTimers()
	})

	it("never auto-dismisses one that needs the user", () => {
		vi.useFakeTimers()
		render(<TaskNotification notification={notification()} taskName="t" onDismiss={onDismiss} onFocus={onFocus} />)
		act(() => {
			vi.advanceTimersByTime(60_000)
		})
		expect(onDismiss).not.toHaveBeenCalled()
		vi.useRealTimers()
	})

	it.each(["needs_input", "completed", "error", "file_conflict", "something-new"])(
		"renders the %s variant",
		(type) => {
			const { container } = render(
				<TaskNotification
					notification={notification({ type: type as never })}
					taskName="t"
					onDismiss={onDismiss}
					onFocus={onFocus}
				/>,
			)
			expect(container.querySelector("svg")).toBeTruthy()
		},
	)
})

describe("TaskNotificationContainer", () => {
	it("renders nothing when there is nothing to say", () => {
		const { container } = render(
			<TaskNotificationContainer notifications={[]} managedTasks={[]} onDismiss={onDismiss} onFocus={onFocus} />,
		)
		expect(container).toBeEmptyDOMElement()
	})

	it("names each notification's task, falling back for one it does not know", () => {
		render(
			<TaskNotificationContainer
				notifications={[notification({ taskId: "known" }), notification({ taskId: "stranger" })]}
				managedTasks={[{ id: "known", name: "The known task" }]}
				onDismiss={onDismiss}
				onFocus={onFocus}
			/>,
		)
		expect(screen.getByText("The known task")).toBeInTheDocument()
		expect(screen.getByText("Unknown Task")).toBeInTheDocument()
	})
})
