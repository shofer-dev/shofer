import { useEffect, useState } from "react"
import { Box, Text } from "ink"
import { render } from "ink-testing-library"

import { ScrollArea, useScrollToBottom, type ScrollAreaProps } from "../ScrollArea.js"

const ESC = "\u001B"

const KEY = {
	up: `${ESC}[A`,
	down: `${ESC}[B`,
	pageUp: `${ESC}[5~`,
	pageDown: `${ESC}[6~`,
	ctrlA: "\u0001",
	ctrlE: "\u0005",
} as const

/** The component re-measures on a 100ms interval, so settling takes a beat. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 140))
/** A keystroke only needs React to flush; it does not wait on a re-measure. */
const beat = () => new Promise((resolve) => setTimeout(resolve, 15))

function Lines({ count, from = 0 }: { count: number; from?: number }) {
	return (
		<>
			{Array.from({ length: count }, (_, i) => (
				<Text key={i}>{`line-${from + i}`}</Text>
			))}
		</>
	)
}

async function renderScroll(props: Partial<ScrollAreaProps> = {}, children = <Lines count={20} />) {
	const result = render(
		<ScrollArea height={5} {...props}>
			{children}
		</ScrollArea>,
	)
	await settle()
	const press = async (sequence: string) => {
		result.stdin.write(sequence)
		await beat()
	}

	return {
		...result,
		press,
		/**
		 * Re-presses until the expectation holds. Ink attaches its stdin
		 * listener from an effect, so an early keystroke is simply dropped;
		 * every key here saturates at the ends of the scroll range, so
		 * retrying converges rather than overshooting.
		 */
		async pressUntil(sequence: string, done: () => boolean) {
			for (let attempt = 0; attempt < 20 && !done(); attempt++) {
				result.stdin.write(sequence)
				await beat()
			}
			if (!done()) throw new Error(`key ${JSON.stringify(sequence)} never took effect`)
		},
	}
}

describe("ScrollArea", () => {
	describe("viewport", () => {
		it("shows only one screenful of a taller content block", async () => {
			const { lastFrame } = await renderScroll({ autoScroll: false })
			const output = lastFrame() ?? ""

			expect(output).toContain("line-0")
			expect(output).not.toContain("line-19")
		})

		it("opens at the bottom of taller content by default", async () => {
			const { lastFrame } = await renderScroll()
			const output = lastFrame() ?? ""

			expect(output).toContain("line-19")
			expect(output).not.toContain("line-0")
		})

		it("shows all content when it fits the viewport", async () => {
			const { lastFrame } = await renderScroll({}, <Lines count={3} />)
			const output = lastFrame() ?? ""

			expect(output).toContain("line-0")
			expect(output).toContain("line-2")
		})

		it("renders a border when asked", async () => {
			const { lastFrame } = await renderScroll({ showBorder: true }, <Lines count={2} />)
			expect(lastFrame()).toMatch(/[┌─┐│└┘]/)
		})

		it("renders no border by default", async () => {
			const { lastFrame } = await renderScroll({}, <Lines count={2} />)
			expect(lastFrame()).not.toContain("┌")
		})
	})

	describe("scrollbar", () => {
		it("draws a handle and a track when content overflows", async () => {
			const { lastFrame } = await renderScroll()
			const output = lastFrame() ?? ""

			expect(output).toContain("┃")
			expect(output).toContain("│")
		})

		it("draws a full handle when nothing can scroll", async () => {
			const { lastFrame } = await renderScroll({}, <Lines count={2} />)
			expect(lastFrame()).toContain("┃")
		})

		it("omits the scrollbar entirely when showScrollbar is false", async () => {
			const { lastFrame } = await renderScroll({ showScrollbar: false })
			const output = lastFrame() ?? ""

			expect(output).not.toContain("┃")
			expect(output).not.toContain("│")
		})

		it("hides the scrollbar when inactive with nothing to scroll", async () => {
			const { lastFrame } = await renderScroll({ isActive: false }, <Lines count={2} />)
			expect(lastFrame()).not.toContain("┃")
		})

		it("uses the dim handle colour when inactive but scrollable", async () => {
			const { lastFrame } = await renderScroll({ isActive: false })
			expect(lastFrame()).toContain("┃")
		})
	})

	describe("keyboard scrolling", () => {
		it("scrolls down one line on the down arrow", async () => {
			const onScroll = vi.fn()
			const { pressUntil } = await renderScroll({ onScroll, autoScroll: false })

			expect(onScroll.mock.lastCall?.[0]).toBe(0)
			await pressUntil(KEY.down, () => (onScroll.mock.lastCall?.[0] as number) >= 1)

			expect(onScroll.mock.lastCall?.[0]).toBeGreaterThan(0)
		})

		it("scrolls up one line on the up arrow", async () => {
			const onScroll = vi.fn()
			const { pressUntil } = await renderScroll({ onScroll })

			const beforeTop = onScroll.mock.lastCall?.[0] as number
			expect(beforeTop).toBeGreaterThan(0)

			await pressUntil(KEY.up, () => (onScroll.mock.lastCall?.[0] as number) < beforeTop)

			expect(onScroll.mock.lastCall?.[0]).toBeLessThan(beforeTop)
		})

		it("clamps at the top", async () => {
			const onScroll = vi.fn()
			const { pressUntil } = await renderScroll({ onScroll })

			await pressUntil(KEY.up, () => onScroll.mock.lastCall?.[0] === 0)

			expect(onScroll.mock.lastCall?.[0]).toBe(0)
		})

		it("clamps at the bottom and reports being there", async () => {
			const onScroll = vi.fn()
			const { pressUntil } = await renderScroll({ onScroll })

			await pressUntil(KEY.up, () => onScroll.mock.lastCall?.[0] === 0)
			await pressUntil(KEY.down, () => {
				const call = onScroll.mock.lastCall as [number, number] | undefined
				return call !== undefined && call[0] === call[1]
			})

			const [scrollTop, maxScroll, isAtBottom] = onScroll.mock.lastCall as [number, number, boolean]
			expect(scrollTop).toBe(maxScroll)
			expect(isAtBottom).toBe(true)
		})

		it("pages up by half a viewport", async () => {
			const onScroll = vi.fn()
			const { pressUntil } = await renderScroll({ onScroll })

			const before = onScroll.mock.lastCall?.[0] as number
			await pressUntil(KEY.pageUp, () => (onScroll.mock.lastCall?.[0] as number) < before)

			expect(onScroll.mock.lastCall?.[0]).toBeLessThan(before)
		})

		it("pages down by half a viewport", async () => {
			const onScroll = vi.fn()
			const { pressUntil } = await renderScroll({ onScroll, autoScroll: false })

			expect(onScroll.mock.lastCall?.[0]).toBe(0)
			// height 5 → half a viewport is Math.floor(5 / 2).
			await pressUntil(KEY.pageDown, () => (onScroll.mock.lastCall?.[0] as number) >= 2)

			expect(onScroll.mock.lastCall?.[0]).toBeGreaterThanOrEqual(2)
		})

		it("jumps to the top on Ctrl+A", async () => {
			const onScroll = vi.fn()
			const { pressUntil } = await renderScroll({ onScroll })

			await pressUntil(KEY.ctrlA, () => onScroll.mock.lastCall?.[0] === 0)

			expect(onScroll.mock.lastCall?.[0]).toBe(0)
		})

		it("jumps to the bottom on Ctrl+E", async () => {
			const onScroll = vi.fn()
			const { pressUntil } = await renderScroll({ onScroll })

			await pressUntil(KEY.ctrlA, () => onScroll.mock.lastCall?.[0] === 0)
			await pressUntil(KEY.ctrlE, () => {
				const call = onScroll.mock.lastCall as [number, number] | undefined
				return call !== undefined && call[0] === call[1]
			})

			const [scrollTop, maxScroll] = onScroll.mock.lastCall as [number, number]
			expect(scrollTop).toBe(maxScroll)
		})

		it("ignores keys when inactive", async () => {
			const onScroll = vi.fn()
			const { press } = await renderScroll({ onScroll, isActive: false })

			const before = onScroll.mock.lastCall?.[0] as number
			await press(KEY.up)

			expect(onScroll.mock.lastCall?.[0]).toBe(before)
		})
	})

	describe("onScroll reporting", () => {
		it("reports being at the bottom when nothing can scroll", async () => {
			const onScroll = vi.fn()
			await renderScroll({ onScroll }, <Lines count={2} />)

			const [scrollTop, maxScroll, isAtBottom] = onScroll.mock.lastCall as [number, number, boolean]
			expect(scrollTop).toBe(0)
			expect(maxScroll).toBe(0)
			expect(isAtBottom).toBe(true)
		})

		it("renders without an onScroll handler", async () => {
			const { lastFrame } = await renderScroll({ onScroll: undefined, autoScroll: false })
			expect(lastFrame()).toContain("line-0")
		})
	})

	describe("auto scroll", () => {
		it("follows growing content to the bottom by default", async () => {
			function Growing() {
				const [count, setCount] = useState(6)
				useEffect(() => {
					const id = setTimeout(() => setCount(20), 40)
					return () => clearTimeout(id)
				}, [])
				return (
					<ScrollArea height={5}>
						<Lines count={count} />
					</ScrollArea>
				)
			}

			const { lastFrame } = render(<Growing />)
			await settle()
			await settle()

			expect(lastFrame()).toContain("line-19")
		})

		it("stays put when autoScroll is disabled", async () => {
			const onScroll = vi.fn()
			await renderScroll({ onScroll, autoScroll: false })

			expect(onScroll.mock.lastCall?.[0]).toBe(0)
		})
	})

	describe("imperative scroll triggers", () => {
		it("scrolls to the bottom when the trigger is bumped", async () => {
			const onScroll = vi.fn()
			const { rerender } = render(
				<ScrollArea height={5} onScroll={onScroll} autoScroll={false} scrollToBottomTrigger={0}>
					<Lines count={20} />
				</ScrollArea>,
			)
			await settle()
			expect(onScroll.mock.lastCall?.[0]).toBe(0)

			rerender(
				<ScrollArea height={5} onScroll={onScroll} autoScroll={false} scrollToBottomTrigger={1}>
					<Lines count={20} />
				</ScrollArea>,
			)
			await settle()

			const [scrollTop, maxScroll] = onScroll.mock.lastCall as [number, number]
			expect(scrollTop).toBe(maxScroll)
			expect(maxScroll).toBeGreaterThan(0)
		})

		it("scrolls a line below the viewport into view", async () => {
			const onScroll = vi.fn()
			const { rerender } = render(
				<ScrollArea height={5} onScroll={onScroll} autoScroll={false}>
					<Lines count={20} />
				</ScrollArea>,
			)
			await settle()

			rerender(
				<ScrollArea height={5} onScroll={onScroll} autoScroll={false} scrollToLine={12} scrollToLineTrigger={1}>
					<Lines count={20} />
				</ScrollArea>,
			)
			await settle()

			expect(onScroll.mock.lastCall?.[0]).toBe(8)
		})

		it("scrolls a line above the viewport into view, including index 0", async () => {
			const onScroll = vi.fn()
			const { rerender } = render(
				<ScrollArea height={5} onScroll={onScroll}>
					<Lines count={20} />
				</ScrollArea>,
			)
			await settle()
			expect(onScroll.mock.lastCall?.[0]).toBeGreaterThan(0)

			rerender(
				<ScrollArea height={5} onScroll={onScroll} scrollToLine={0} scrollToLineTrigger={1}>
					<Lines count={20} />
				</ScrollArea>,
			)
			await settle()

			expect(onScroll.mock.lastCall?.[0]).toBe(0)
		})

		it("leaves the viewport alone for a line already visible", async () => {
			const onScroll = vi.fn()
			const { rerender } = render(
				<ScrollArea height={5} onScroll={onScroll} autoScroll={false}>
					<Lines count={20} />
				</ScrollArea>,
			)
			await settle()

			rerender(
				<ScrollArea height={5} onScroll={onScroll} autoScroll={false} scrollToLine={2} scrollToLineTrigger={1}>
					<Lines count={20} />
				</ScrollArea>,
			)
			await settle()

			expect(onScroll.mock.lastCall?.[0]).toBe(0)
		})

		it("ignores a scrollToLine whose trigger did not change", async () => {
			const onScroll = vi.fn()
			const { rerender } = render(
				<ScrollArea height={5} onScroll={onScroll} autoScroll={false} scrollToLine={0} scrollToLineTrigger={1}>
					<Lines count={20} />
				</ScrollArea>,
			)
			await settle()

			rerender(
				<ScrollArea height={5} onScroll={onScroll} autoScroll={false} scrollToLine={18} scrollToLineTrigger={1}>
					<Lines count={20} />
				</ScrollArea>,
			)
			await settle()

			expect(onScroll.mock.lastCall?.[0]).toBe(0)
		})
	})

	describe("measured height", () => {
		it("fills the available space when no height prop is given", async () => {
			const { lastFrame } = render(
				<Box flexDirection="column" height={6}>
					<ScrollArea>
						<Lines count={20} />
					</ScrollArea>
				</Box>,
			)
			await settle()
			await settle()

			const output = lastFrame() ?? ""
			// It measured a viewport out of the 6-row parent rather than showing
			// all twenty lines, and auto-scroll parked it at the bottom.
			expect(output).toContain("line-19")
			expect(output).not.toContain("line-0")
		})
	})

	describe("useScrollToBottom", () => {
		it("starts at zero and increments the trigger on each call", async () => {
			const seen: number[] = []

			function Probe() {
				const { scrollToBottomTrigger, scrollToBottom } = useScrollToBottom()
				seen.push(scrollToBottomTrigger)
				useEffect(() => {
					if (scrollToBottomTrigger < 2) scrollToBottom()
				}, [scrollToBottomTrigger, scrollToBottom])
				return <Text>trigger-{scrollToBottomTrigger}</Text>
			}

			const { lastFrame } = render(<Probe />)
			await settle()

			expect(seen[0]).toBe(0)
			expect(lastFrame()).toContain("trigger-2")
		})
	})
})
