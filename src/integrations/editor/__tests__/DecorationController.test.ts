// npx vitest src/integrations/editor/__tests__/DecorationController.test.ts

/**
 * The decoration controller paints the streaming-edit overlay. Two things it
 * does are load-bearing rather than cosmetic: the decoration types are created
 * LAZILY (importing this module must not touch `vscode.window`, so it is safe in
 * the host adapter's graph), and `addLines` COALESCES a range with the previous
 * one when they are contiguous — without which a long streamed edit accumulates
 * one range per chunk and the editor slows down as the file grows.
 */

const hoisted = vi.hoisted(() => ({
	created: [] as unknown[],
	createTextEditorDecorationType: vi.fn(),
}))

vi.mock("vscode", () => {
	class Position {
		constructor(
			public line: number,
			public character: number,
		) {}
		translate(lineDelta: number) {
			return new Position(this.line + lineDelta, this.character)
		}
	}
	class Range {
		start: Position
		end: Position
		constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
			if (a instanceof Position && b instanceof Position) {
				this.start = a
				this.end = b
			} else {
				this.start = new Position(a as number, b as number)
				this.end = new Position(c as number, d as number)
			}
		}
		with(start?: Position, end?: Position) {
			return new Range(start ?? this.start, end ?? this.end)
		}
	}
	const createTextEditorDecorationType = (options: unknown) => {
		hoisted.createTextEditorDecorationType(options)
		const type = { id: hoisted.created.length, options }
		hoisted.created.push(type)
		return type
	}
	return { Position, Range, window: { createTextEditorDecorationType } }
})

import { DecorationController } from "../DecorationController"

function makeEditor() {
	return { setDecorations: vi.fn() } as unknown as import("vscode").TextEditor & {
		setDecorations: ReturnType<typeof vi.fn>
	}
}

function lastRanges(editor: ReturnType<typeof makeEditor>) {
	return editor.setDecorations.mock.calls.at(-1)![1] as Array<{ start: { line: number }; end: { line: number } }>
}

beforeEach(() => vi.clearAllMocks())

describe("decoration types", () => {
	it("are created lazily — constructing a controller touches vscode.window not at all", () => {
		new DecorationController("fadedOverlay", makeEditor())
		expect(hoisted.createTextEditorDecorationType).not.toHaveBeenCalled()
	})

	it("are created once per KIND and then reused across controllers", () => {
		const a = new DecorationController("fadedOverlay", makeEditor())
		const b = new DecorationController("fadedOverlay", makeEditor())
		const c = new DecorationController("activeLine", makeEditor())

		expect(a.getDecoration()).toBe(b.getDecoration())
		expect(c.getDecoration()).not.toBe(a.getDecoration())
	})
})

describe("addLines", () => {
	it("ignores a negative start index", () => {
		const editor = makeEditor()
		new DecorationController("fadedOverlay", editor).addLines(-1, 3)
		expect(editor.setDecorations).not.toHaveBeenCalled()
	})

	it("ignores a non-positive line count", () => {
		const editor = makeEditor()
		new DecorationController("fadedOverlay", editor).addLines(0, 0)
		expect(editor.setDecorations).not.toHaveBeenCalled()
	})

	it("adds one range spanning the requested lines", () => {
		const editor = makeEditor()
		new DecorationController("fadedOverlay", editor).addLines(2, 3)

		const ranges = lastRanges(editor)
		expect(ranges).toHaveLength(1)
		expect(ranges[0].start.line).toBe(2)
		expect(ranges[0].end.line).toBe(4)
	})

	it("EXTENDS the previous range when the new block starts on the very next line", () => {
		const editor = makeEditor()
		const controller = new DecorationController("fadedOverlay", editor)

		controller.addLines(0, 2) // lines 0..1
		controller.addLines(2, 3) // contiguous → merged

		const ranges = lastRanges(editor)
		expect(ranges).toHaveLength(1)
		expect(ranges[0].end.line).toBe(4)
	})

	it("keeps a SEPARATE range when there is a gap", () => {
		const editor = makeEditor()
		const controller = new DecorationController("fadedOverlay", editor)

		controller.addLines(0, 2) // 0..1
		controller.addLines(5, 1) // gap at 2..4

		expect(lastRanges(editor)).toHaveLength(2)
	})
})

describe("clear / setActiveLine / updateOverlayAfterLine", () => {
	it("clear applies an empty range list, which is how the overlay is removed", () => {
		const editor = makeEditor()
		const controller = new DecorationController("fadedOverlay", editor)

		controller.addLines(0, 3)
		controller.clear()

		expect(lastRanges(editor)).toEqual([])
	})

	it("setActiveLine REPLACES the range set — the active line is a singleton", () => {
		const editor = makeEditor()
		const controller = new DecorationController("activeLine", editor)

		controller.setActiveLine(3)
		controller.setActiveLine(7)

		const ranges = lastRanges(editor)
		expect(ranges).toHaveLength(1)
		expect(ranges[0].start.line).toBe(7)
	})

	it("updateOverlayAfterLine drops ranges the cursor has passed and fades the remainder", () => {
		const editor = makeEditor()
		const controller = new DecorationController("fadedOverlay", editor)

		controller.addLines(0, 2) // 0..1
		controller.addLines(5, 2) // 5..6
		controller.updateOverlayAfterLine(4, 10)

		const ranges = lastRanges(editor)
		expect(ranges).toHaveLength(2)
		expect(ranges[0].end.line).toBe(1) // kept: entirely before line 4
		expect(ranges[1].start.line).toBe(5) // the new "everything after" range
		expect(ranges[1].end.line).toBe(9)
	})

	it("adds NO trailing range once the cursor is on the last line", () => {
		const editor = makeEditor()
		const controller = new DecorationController("fadedOverlay", editor)

		controller.updateOverlayAfterLine(9, 10)

		expect(lastRanges(editor)).toEqual([])
	})
})
