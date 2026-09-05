// npx vitest src/components/chat/__tests__/TaskSequenceView.spec.tsx

import { render, screen, fireEvent, act } from "@/utils/test-utils"

import type { HistoryItem, TaskInteractionPayload } from "@shofer/types"

import TaskSequenceView from "../TaskSequenceView"

const postMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: (m: unknown) => postMessage(m) } }))

const item = (over: Partial<HistoryItem> & { id: string }): HistoryItem =>
	({
		ts: 1,
		task: `task ${over.id}`,
		tokensIn: 0,
		tokensOut: 0,
		cacheWrites: 0,
		cacheReads: 0,
		totalCost: 0,
		...over,
	}) as HistoryItem

const ix = (over: Partial<TaskInteractionPayload> & { fromTaskId: string }): TaskInteractionPayload =>
	({ kind: "message", label: "hello", rootOffsetMs: 0, ...over }) as TaskInteractionPayload

/** Deliver the host's answer to the view's `getTaskInteractions` request. */
const answer = (rootTaskId: string, taskInteractions: unknown) =>
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", { data: { type: "taskInteractions", text: rootTaskId, taskInteractions } }),
		)
	})

// jsdom implements neither `getScreenCTM` nor `createSVGPoint`; the pan/zoom
// hook needs both to map screen pixels into user space. Supply an identity
// matrix so the geometry the hook computes is exercised for real.
beforeAll(() => {
	const proto = SVGSVGElement.prototype as unknown as Record<string, unknown>
	proto.getScreenCTM = () => ({ a: 1, d: 1, inverse: () => ({}) })
	proto.createSVGPoint = () => ({
		x: 0,
		y: 0,
		matrixTransform(this: { x: number; y: number }) {
			return { x: this.x, y: this.y }
		},
	})
})

beforeEach(() => vi.clearAllMocks())

describe("TaskSequenceView", () => {
	it("asks the host for the root's interactions and shows a loading state meanwhile", () => {
		render(<TaskSequenceView rootTaskId="root" taskHistory={[]} />)
		expect(postMessage).toHaveBeenCalledWith({ type: "getTaskInteractions", text: "root" })
		expect(screen.getByText("Loading…")).toBeInTheDocument()
	})

	it("says so when the root has no interactions", () => {
		render(<TaskSequenceView rootTaskId="root" taskHistory={[]} />)
		answer("root", [])
		expect(screen.getByText(/No inter-task interactions recorded/)).toBeInTheDocument()
	})

	it("renders nothing to load without a root task", () => {
		render(<TaskSequenceView taskHistory={[]} />)
		expect(postMessage).not.toHaveBeenCalled()
		expect(screen.getByText(/No inter-task interactions recorded/)).toBeInTheDocument()
	})

	it("ignores an answer addressed to a different root", () => {
		render(<TaskSequenceView rootTaskId="root" taskHistory={[]} />)
		answer("other", [ix({ fromTaskId: "root", toTaskId: "child" })])
		expect(screen.getByText("Loading…")).toBeInTheDocument()
	})

	it("tolerates a non-array payload", () => {
		render(<TaskSequenceView rootTaskId="root" taskHistory={[]} />)
		answer("root", null)
		expect(screen.getByText(/No inter-task interactions recorded/)).toBeInTheDocument()
	})

	it("draws a lifeline per task with the root leftmost, ordered by creation", () => {
		const history = [
			item({ id: "root", createdAt: 100, task: "the root task" }),
			item({ id: "later", rootTaskId: "root", createdAt: 300, task: "later child" }),
			item({ id: "early", rootTaskId: "root", createdAt: 200, task: "early child" }),
			item({ id: "elsewhere", rootTaskId: "other-root", createdAt: 50 }),
		]
		const { container } = render(<TaskSequenceView rootTaskId="root" taskHistory={history} />)
		answer("root", [
			ix({ fromTaskId: "root", toTaskId: "early", kind: "spawn", rootOffsetMs: 10 }),
			ix({ fromTaskId: "root", toTaskId: "later", kind: "spawn", rootOffsetMs: 20 }),
		])

		const headers = Array.from(container.querySelectorAll("text > title")).map((t) => t.textContent)
		expect(headers).toEqual(["the root task", "early child", "later child"])
		// The task from a different tree is not a lifeline here.
		expect(headers).not.toContain("elsewhere")
	})

	it("names a lifeline by its id prefix when history knows nothing about it", () => {
		const { container } = render(<TaskSequenceView rootTaskId="root" taskHistory={[]} />)
		answer("root", [ix({ fromTaskId: "root", toTaskId: "abcdef0123456789", rootOffsetMs: 5 })])
		const headers = Array.from(container.querySelectorAll("text > title")).map((t) => t.textContent)
		expect(headers).toContain("abcdef01")
	})

	it("orders arrows chronologically regardless of the host's ordering", () => {
		const { container } = render(
			<TaskSequenceView rootTaskId="root" taskHistory={[item({ id: "root", createdAt: 1 })]} />,
		)
		answer("root", [
			ix({ fromTaskId: "root", toTaskId: "b", label: "second", rootOffsetMs: 200 }),
			ix({ fromTaskId: "root", toTaskId: "b", label: "first", rootOffsetMs: 100 }),
		])
		const labels = Array.from(container.querySelectorAll("text"))
			.map((t) => t.textContent)
			.filter((t) => t?.startsWith("message:"))
		expect(labels).toEqual(["message: first", "message: second"])
	})

	it("colours a failed interaction with the error arrowhead", () => {
		const { container } = render(<TaskSequenceView rootTaskId="root" taskHistory={[]} />)
		answer("root", [ix({ fromTaskId: "root", toTaskId: "b", isError: true })])
		expect(container.querySelector('line[marker-end="url(#seqah-error)"]')).toBeTruthy()
	})

	it("dashes an async interaction", () => {
		const { container } = render(<TaskSequenceView rootTaskId="root" taskHistory={[]} />)
		answer("root", [ix({ fromTaskId: "root", toTaskId: "b", async: true })])
		expect(container.querySelector('line[stroke-dasharray="5 3"]')).toBeTruthy()
	})

	it("draws a self-directed interaction as a stub on one lifeline", () => {
		const { container } = render(<TaskSequenceView rootTaskId="root" taskHistory={[]} />)
		answer("root", [ix({ fromTaskId: "root", kind: "await", label: "waiting" })])
		expect(container.querySelectorAll("rect").length).toBeGreaterThan(0)
		expect(screen.getByText("await: waiting")).toBeInTheDocument()
	})

	it("shows a hover tooltip carrying the endpoints, timing and sync-ness", () => {
		const { container } = render(
			<TaskSequenceView
				rootTaskId="root"
				taskHistory={[item({ id: "root", createdAt: 1, task: "root task" })]}
			/>,
		)
		answer("root", [ix({ fromTaskId: "root", toTaskId: "child", rootOffsetMs: 1500, isError: true })])

		const hit = container.querySelector("line.seq-arrow")!
		fireEvent.mouseEnter(hit, { clientX: 10, clientY: 20 })
		expect(screen.getByText(/message · sync · failed/)).toBeInTheDocument()
		expect(screen.getByText(/Time: t\+1\.5s/)).toBeInTheDocument()

		fireEvent.mouseMove(hit, { clientX: 12, clientY: 22 })
		expect(screen.getByText(/From: root task/)).toBeInTheDocument()

		fireEvent.mouseLeave(hit)
		expect(screen.queryByText(/message · sync/)).not.toBeInTheDocument()
	})

	it("shows the tooltip for a self-directed stub too", () => {
		const { container } = render(<TaskSequenceView rootTaskId="root" taskHistory={[]} />)
		answer("root", [ix({ fromTaskId: "root", kind: "cancel", label: "", rootOffsetMs: 90_000 })])
		fireEvent.mouseEnter(container.querySelector("line.seq-arrow")!, { clientX: 1, clientY: 1 })
		expect(screen.getByText(/Time: t\+1m 30s/)).toBeInTheDocument()
		fireEvent.mouseLeave(container.querySelector("line.seq-arrow")!)
	})

	it("truncates a long lifeline title and a long arrow label", () => {
		const { container } = render(
			<TaskSequenceView
				rootTaskId="root"
				taskHistory={[item({ id: "root", createdAt: 1, task: "x".repeat(80) })]}
			/>,
		)
		answer("root", [ix({ fromTaskId: "root", toTaskId: "b", label: "y".repeat(80) })])
		const arrowLabel = Array.from(container.querySelectorAll("text")).find((t) =>
			t.textContent?.startsWith("message: y"),
		)!
		expect(arrowLabel.textContent).toMatch(/…$/)
		expect(arrowLabel.textContent!.length).toBe(34)
	})

	it("zooms and refits the canvas from the toolbar", () => {
		const { container } = render(<TaskSequenceView rootTaskId="root" taskHistory={[]} />)
		answer("root", [ix({ fromTaskId: "root", toTaskId: "b" })])

		const svg = container.querySelector("svg")!
		const initial = svg.getAttribute("viewBox")

		fireEvent.click(screen.getByText("+"))
		expect(svg.getAttribute("viewBox")).not.toBe(initial)

		fireEvent.click(screen.getByText("−"))
		fireEvent.click(screen.getByText("Fit"))
		expect(svg.getAttribute("viewBox")).toBe(initial)
	})

	it("pans the canvas on a background drag but not from an arrow", () => {
		const { container } = render(<TaskSequenceView rootTaskId="root" taskHistory={[]} />)
		answer("root", [ix({ fromTaskId: "root", toTaskId: "b" })])

		const svg = container.querySelector("svg")!
		const initial = svg.getAttribute("viewBox")

		// A mousedown on the arrow hit-area is excluded by `noPanSelector`.
		fireEvent.mouseDown(container.querySelector("line.seq-arrow")!, { clientX: 0, clientY: 0 })
		fireEvent.mouseMove(svg, { clientX: 40, clientY: 25 })
		expect(svg.getAttribute("viewBox")).toBe(initial)

		fireEvent.mouseDown(svg, { clientX: 0, clientY: 0 })
		fireEvent.mouseMove(svg, { clientX: 40, clientY: 25 })
		expect(svg.getAttribute("viewBox")).not.toBe(initial)

		fireEvent.mouseUp(svg)
		const parked = svg.getAttribute("viewBox")
		fireEvent.mouseMove(svg, { clientX: 90, clientY: 90 })
		expect(svg.getAttribute("viewBox")).toBe(parked)
	})

	it("zooms about the cursor on a wheel event", () => {
		const { container } = render(<TaskSequenceView rootTaskId="root" taskHistory={[]} />)
		answer("root", [ix({ fromTaskId: "root", toTaskId: "b" })])

		const svg = container.querySelector("svg")!
		const initial = svg.getAttribute("viewBox")
		fireEvent.wheel(svg, { deltaY: 100, clientX: 10, clientY: 10 })
		const out = svg.getAttribute("viewBox")
		expect(out).not.toBe(initial)
		fireEvent.wheel(svg, { deltaY: -100, clientX: 10, clientY: 10 })
		expect(svg.getAttribute("viewBox")).not.toBe(out)
	})

	it("legends every interaction kind", () => {
		render(<TaskSequenceView rootTaskId="root" taskHistory={[]} />)
		answer("root", [ix({ fromTaskId: "root", toTaskId: "b" })])
		for (const kind of ["spawn", "message", "await", "answer", "cancel", "question"]) {
			expect(screen.getByText(kind)).toBeInTheDocument()
		}
		expect(screen.getByText("Async")).toBeInTheDocument()
		expect(screen.getByText("Failed")).toBeInTheDocument()
	})
})
