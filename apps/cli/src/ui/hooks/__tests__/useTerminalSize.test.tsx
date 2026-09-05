// pnpm --filter @shofer/cli test src/ui/hooks/__tests__/useTerminalSize.test.tsx

import React from "react"
import { Text } from "ink"

import { TerminalSizeProvider, useTerminalSize as useTerminalSizeFromContext } from "../TerminalSizeContext.js"
import { useTerminalSize } from "../useTerminalSize.js"
import { renderHook, renderInk } from "./helpers/render-hook.js"

/**
 * Terminal geometry. `useTerminalSize` reads `process.stdout` and subscribes to
 * its `resize` event, debouncing by 50ms because a drag emits a burst of them and
 * Ink repaints on every state change. `TerminalSizeContext` exists so exactly ONE
 * subscription is live no matter how many components want the size.
 */
describe("useTerminalSize", () => {
	const stdout = process.stdout as NodeJS.WriteStream & { columns: number; rows: number }
	let columns: number | undefined
	let rows: number | undefined

	beforeEach(() => {
		vi.useFakeTimers()
		columns = stdout.columns
		rows = stdout.rows
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
		Object.defineProperty(stdout, "columns", { value: columns, configurable: true, writable: true })
		Object.defineProperty(stdout, "rows", { value: rows, configurable: true, writable: true })
	})

	const setSize = (nextColumns: number | undefined, nextRows: number | undefined) => {
		Object.defineProperty(stdout, "columns", { value: nextColumns, configurable: true, writable: true })
		Object.defineProperty(stdout, "rows", { value: nextRows, configurable: true, writable: true })
	}

	it("reads the current terminal size on first render", () => {
		setSize(123, 45)
		const hook = renderHook(() => useTerminalSize())

		expect(hook.current).toEqual({ columns: 123, rows: 45 })
		hook.unmount()
	})

	it("falls back to 80x24 when the stream reports no geometry (a pipe, not a TTY)", () => {
		setSize(undefined, undefined)
		const hook = renderHook(() => useTerminalSize())

		expect(hook.current).toEqual({ columns: 80, rows: 24 })
		hook.unmount()
	})

	it("debounces a burst of resizes into one update, and clears the screen first", () => {
		setSize(100, 40)
		const write = vi.spyOn(stdout, "write").mockReturnValue(true)
		const hook = renderHook(() => useTerminalSize())

		setSize(120, 50)
		hook.act(() => {
			stdout.emit("resize")
			stdout.emit("resize")
			stdout.emit("resize")
		})

		// Still the old size: nothing has fired yet.
		expect(hook.current).toEqual({ columns: 100, rows: 40 })

		hook.act(() => {
			vi.advanceTimersByTime(50)
		})

		expect(hook.current).toEqual({ columns: 120, rows: 50 })
		expect(write).toHaveBeenCalledTimes(1)
		expect(write).toHaveBeenCalledWith("\x1b[2J\x1b[H")

		hook.unmount()
	})

	it("unsubscribes and drops a pending debounce on unmount", () => {
		setSize(100, 40)
		vi.spyOn(stdout, "write").mockReturnValue(true)
		const before = stdout.listenerCount("resize")

		const hook = renderHook(() => useTerminalSize())
		expect(stdout.listenerCount("resize")).toBe(before + 1)

		hook.act(() => {
			stdout.emit("resize")
		})
		hook.unmount()

		expect(stdout.listenerCount("resize")).toBe(before)
		// The queued update must not fire against an unmounted tree.
		expect(() => vi.advanceTimersByTime(50)).not.toThrow()
	})
})

describe("TerminalSizeContext", () => {
	it("hands the size down to its children", () => {
		const Probe = () => {
			const { columns, rows } = useTerminalSizeFromContext()
			return <Text>{`${columns}x${rows}`}</Text>
		}

		const { lastFrame, unmount } = renderInk(
			<TerminalSizeProvider>
				<Probe />
			</TerminalSizeProvider>,
		)

		expect(lastFrame()).toMatch(/^\d+x\d+$/)
		unmount()
	})

	it("refuses to answer outside a provider, rather than inventing a size", () => {
		const Probe = () => {
			useTerminalSizeFromContext()
			return null
		}

		// Ink's reconciler surfaces a render throw to an error boundary rather than
		// to the caller of `render`, so that is where the refusal is observed.
		const errors: Error[] = []

		class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
			override state = { failed: false }
			static getDerivedStateFromError() {
				return { failed: true }
			}
			override componentDidCatch(error: Error) {
				errors.push(error)
			}
			override render() {
				return this.state.failed ? null : this.props.children
			}
		}

		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
		const { unmount } = renderInk(
			<Boundary>
				<Probe />
			</Boundary>,
		)
		consoleError.mockRestore()

		expect(errors.map((e) => e.message)).toContain("useTerminalSize must be used within a TerminalSizeProvider")
		unmount()
	})
})
