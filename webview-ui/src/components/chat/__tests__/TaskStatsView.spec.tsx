// npx vitest src/components/chat/__tests__/TaskStatsView.spec.tsx

import { render, screen, fireEvent } from "@/utils/test-utils"

import type { ApiRequestFinishedPayload, ShoferMessage } from "@shofer/types"

import TaskStatsView from "../TaskStatsView"

const payload = (over: Partial<ApiRequestFinishedPayload> = {}): ApiRequestFinishedPayload =>
	({
		requestIndex: 0,
		taskId: "t1",
		parentTaskId: null,
		startedAtOffsetMs: 0,
		finishedAtOffsetMs: 1000,
		ttfbMs: 100,
		model: "m",
		apiProtocol: "openai",
		retryAttempt: 0,
		tokensIn: 1,
		tokensOut: 1,
		cacheWrites: 0,
		cacheReads: 0,
		cost: 0,
		status: "completed",
		toolSpans: [],
		...over,
	}) as ApiRequestFinishedPayload

const messages = (...payloads: ApiRequestFinishedPayload[]): ShoferMessage[] =>
	payloads.map(
		(p, i) => ({ ts: i + 1, type: "say", say: "api_req_finished", text: JSON.stringify(p) }) as ShoferMessage,
	)

describe("TaskStatsView", () => {
	it("explains the empty state when no request has finished", () => {
		render(<TaskStatsView messages={[]} />)
		expect(screen.getByText(/No timing data recorded yet/)).toBeInTheDocument()
	})

	it("treats a malformed payload as no data", () => {
		render(
			<TaskStatsView
				messages={[{ ts: 1, type: "say", say: "api_req_finished", text: "{oops" } as ShoferMessage]}
			/>,
		)
		expect(screen.getByText(/No timing data recorded yet/)).toBeInTheDocument()
	})

	it("draws one legend row per non-empty phase and reports the request count", () => {
		render(<TaskStatsView messages={messages(payload())} />)

		expect(screen.getByText("Waiting for model")).toBeInTheDocument()
		expect(screen.getByText("Streaming response")).toBeInTheDocument()
		// Thinking is zero-length here, so it gets no slice.
		expect(screen.queryByText("Thinking")).not.toBeInTheDocument()
		expect(screen.getByText(/1 request ·/)).toBeInTheDocument()
	})

	it("pluralises the request count", () => {
		render(
			<TaskStatsView
				messages={messages(payload(), payload({ startedAtOffsetMs: 2000, finishedAtOffsetMs: 3000 }))}
			/>,
		)
		expect(screen.getByText(/2 requests ·/)).toBeInTheDocument()
	})

	it("adds an overhead slice when the header's active time exceeds the measured spans", () => {
		render(<TaskStatsView messages={messages(payload())} activeMs={2000} />)
		expect(screen.getByText("Overhead")).toBeInTheDocument()
		expect(screen.getByText("2.0s")).toBeInTheDocument()
	})

	it("renders a single phase as a ring rather than arcs", () => {
		// TTFB covers the whole request, so `llm` is the only slice.
		const { container } = render(<TaskStatsView messages={messages(payload({ ttfbMs: 1000 }))} />)
		expect(container.querySelector("circle")).toBeTruthy()
		expect(container.querySelector("path")).toBeNull()
	})

	it("swaps the centre label to the hovered slice's share", () => {
		const { container } = render(<TaskStatsView messages={messages(payload())} />)
		const arc = container.querySelectorAll("path")[0]
		fireEvent.mouseEnter(arc)
		expect(screen.getAllByText("Waiting for model")).toHaveLength(2)
		expect(screen.getByText("10%")).toBeInTheDocument()
		fireEvent.mouseLeave(arc)
		expect(screen.getByText("active")).toBeInTheDocument()
	})

	it("highlights from the legend too", () => {
		render(<TaskStatsView messages={messages(payload())} />)
		const row = screen.getByText("Streaming response")
		fireEvent.mouseEnter(row)
		expect(screen.getByText("90%")).toBeInTheDocument()
		fireEvent.mouseLeave(row)
	})

	it("hovers the single-slice ring", () => {
		const { container } = render(<TaskStatsView messages={messages(payload({ ttfbMs: 1000 }))} />)
		const ring = container.querySelector("circle")!
		fireEvent.mouseEnter(ring)
		expect(screen.getByText("100%")).toBeInTheDocument()
		fireEvent.mouseLeave(ring)
	})

	it("breaks the tool slice down per tool, with a success ratio", () => {
		render(
			<TaskStatsView
				messages={messages(
					payload({
						toolSpans: [
							{
								startedAtOffsetMs: 200,
								finishedAtOffsetMs: 400,
								toolName: "read_file",
								toolId: "1",
								resultSizeChars: null,
								isError: false,
							},
							{
								startedAtOffsetMs: 400,
								finishedAtOffsetMs: 500,
								toolName: "mcp:srv/tool",
								toolId: "2",
								resultSizeChars: null,
								isError: true,
							},
						],
					}),
				)}
			/>,
		)

		expect(screen.getByText("Tool & MCP calls by tool")).toBeInTheDocument()
		expect(screen.getByText("read_file")).toBeInTheDocument()
		expect(screen.getByText("mcp:srv/tool")).toBeInTheDocument()
		expect(screen.getByText("100%")).toBeInTheDocument()
		expect(screen.getByText("0%")).toBeInTheDocument()
	})
})
