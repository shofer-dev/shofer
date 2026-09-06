// npx vitest src/integrations/editor/__tests__/EditorUtils.context.test.ts

/**
 * `EditorUtils.getEditorContext` is what a code action hands the agent. Two
 * translations in it are load-bearing: line numbers cross from VS Code's
 * 0-based ranges to the 1-based ones the prompt quotes, and the file path is
 * made workspace-RELATIVE (an absolute path in a prompt is both noise and a
 * privacy leak). The empty-selection expansion is the third: acting on the
 * cursor line alone usually gives the model too little, so the range grows by
 * one line either side — but only when the cursor is on a non-blank line.
 */

const hoisted = vi.hoisted(() => ({
	activeTextEditor: undefined as unknown,
	getDiagnostics: vi.fn(() => [] as unknown[]),
	workspaceFolder: { uri: { fsPath: "/w" } } as unknown,
}))

vi.mock("vscode", () => {
	class Position {
		constructor(
			public line: number,
			public character: number,
		) {}
	}
	class Range {
		start: Position
		end: Position
		constructor(a: number | Position, b: number | Position, c?: number, d?: number) {
			this.start = a instanceof Position ? a : new Position(a as number, b as number)
			this.end = a instanceof Position ? (b as Position) : new Position(c as number, d as number)
		}
	}
	return {
		Position,
		Range,
		window: {
			get activeTextEditor() {
				return hoisted.activeTextEditor
			},
		},
		workspace: { getWorkspaceFolder: () => hoisted.workspaceFolder },
		languages: { getDiagnostics: hoisted.getDiagnostics },
		DiagnosticSeverity: { Error: 0, Warning: 1 },
	}
})

import * as vscode from "vscode"

import { EditorUtils } from "../EditorUtils"

/** A document whose lines are `lines`, addressed the way VS Code addresses one. */
function makeDocument(lines: string[], fsPath = "/w/src/a.ts") {
	return {
		uri: { fsPath },
		lineCount: lines.length,
		lineAt: (line: number) => ({ lineNumber: line, text: lines[line] ?? "" }),
		getText: (range?: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
			if (!range) return lines.join("\n")
			if (range.start.line === range.end.line && range.start.character === range.end.character) return ""
			return lines.slice(range.start.line, range.end.line + 1).join("\n")
		},
	} as unknown as vscode.TextDocument
}

function selection(startLine: number, startChar: number, endLine: number, endChar: number) {
	return new vscode.Range(
		new vscode.Position(startLine, startChar),
		new vscode.Position(endLine, endChar),
	) as vscode.Selection
}

beforeEach(() => {
	vi.clearAllMocks()
	hoisted.activeTextEditor = undefined
	hoisted.getDiagnostics.mockReturnValue([])
	hoisted.workspaceFolder = { uri: { fsPath: "/w" } }
})

describe("getEffectiveRange", () => {
	it("uses a NON-EMPTY selection exactly as given", () => {
		const document = makeDocument(["one", "two", "three"])

		const effective = EditorUtils.getEffectiveRange(document, selection(0, 0, 1, 3))

		expect(effective!.text).toBe("one\ntwo")
	})

	it("EXPANDS an empty selection by one line either side", () => {
		const document = makeDocument(["one", "two", "three"])

		const effective = EditorUtils.getEffectiveRange(document, selection(1, 0, 1, 0))

		expect(effective!.range.start.line).toBe(0)
		expect(effective!.range.end.line).toBe(2)
	})

	it("CLAMPS the expansion at the document's edges", () => {
		const document = makeDocument(["only line"])

		const effective = EditorUtils.getEffectiveRange(document, selection(0, 0, 0, 0))

		expect(effective!.range.start.line).toBe(0)
		expect(effective!.range.end.line).toBe(0)
	})

	it("returns NOTHING for a cursor parked on a blank line — there is no context to send", () => {
		const document = makeDocument(["one", "   ", "three"])

		expect(EditorUtils.getEffectiveRange(document, selection(1, 0, 1, 0))).toBeNull()
	})

	it("returns null rather than throwing when the document misbehaves", () => {
		const document = {
			getText: () => {
				throw new Error("document closed")
			},
		} as unknown as vscode.TextDocument

		expect(EditorUtils.getEffectiveRange(document, selection(0, 0, 0, 0))).toBeNull()
	})
})

describe("getFilePath", () => {
	it("is WORKSPACE-RELATIVE for a file inside the workspace", () => {
		expect(EditorUtils.getFilePath(makeDocument([], "/w/src/a.ts"))).toBe("src/a.ts")
	})

	it("stays ABSOLUTE for a file outside the workspace", () => {
		expect(EditorUtils.getFilePath(makeDocument([], "/elsewhere/a.ts"))).toBe("/elsewhere/a.ts")
	})

	it("stays absolute when no workspace folder contains it", () => {
		hoisted.workspaceFolder = undefined

		expect(EditorUtils.getFilePath(makeDocument([], "/anywhere/a.ts"))).toBe("/anywhere/a.ts")
	})

	it("CACHES per document, so repeated code actions do not recompute it", () => {
		const document = makeDocument([], "/w/src/a.ts")

		expect(EditorUtils.getFilePath(document)).toBe("src/a.ts")
		hoisted.workspaceFolder = { uri: { fsPath: "/somewhere-else" } }
		expect(EditorUtils.getFilePath(document)).toBe("src/a.ts")
	})
})

describe("hasIntersectingRange", () => {
	const range = (a: number, b: number, c: number, d: number) =>
		new vscode.Range(new vscode.Position(a, b), new vscode.Position(c, d))

	it("is true for overlapping ranges", () => {
		expect(EditorUtils.hasIntersectingRange(range(0, 0, 2, 0), range(1, 0, 3, 0))).toBe(true)
	})

	it("is false when the first ends before the second begins", () => {
		expect(EditorUtils.hasIntersectingRange(range(0, 0, 1, 0), range(2, 0, 3, 0))).toBe(false)
	})

	it("is false when the second ends before the first begins", () => {
		expect(EditorUtils.hasIntersectingRange(range(4, 0, 5, 0), range(0, 0, 1, 0))).toBe(false)
	})

	it("treats TOUCHING endpoints on one line as NOT intersecting", () => {
		expect(EditorUtils.hasIntersectingRange(range(1, 0, 1, 5), range(1, 5, 1, 9))).toBe(false)
		expect(EditorUtils.hasIntersectingRange(range(1, 5, 1, 9), range(1, 0, 1, 5))).toBe(false)
	})
})

describe("getEditorContext", () => {
	it("returns null with no editor at all", () => {
		expect(EditorUtils.getEditorContext()).toBeNull()
	})

	it("falls back to the ACTIVE editor when none is passed", () => {
		hoisted.activeTextEditor = { document: makeDocument(["one"]), selection: selection(0, 0, 0, 3) }

		expect(EditorUtils.getEditorContext()!.selectedText).toBe("one")
	})

	it("reports ONE-BASED line numbers", () => {
		const editor = { document: makeDocument(["a", "b", "c"]), selection: selection(1, 0, 2, 1) }

		const context = EditorUtils.getEditorContext(editor as never)!

		expect(context.startLine).toBe(2)
		expect(context.endLine).toBe(3)
	})

	it("returns null when the effective range could not be computed", () => {
		const editor = { document: makeDocument(["a", "   ", "c"]), selection: selection(1, 0, 1, 0) }

		expect(EditorUtils.getEditorContext(editor as never)).toBeNull()
	})

	it("carries only the diagnostics that INTERSECT the effective range", () => {
		hoisted.getDiagnostics.mockReturnValue([
			{
				message: "in range",
				severity: 0,
				code: "E1",
				source: "ts",
				range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(1, 0)),
			},
			{
				message: "far away",
				severity: 1,
				range: new vscode.Range(new vscode.Position(9, 0), new vscode.Position(9, 1)),
			},
		])
		const editor = { document: makeDocument(["a", "b", "c"]), selection: selection(0, 0, 1, 1) }

		const context = EditorUtils.getEditorContext(editor as never)!

		expect(context.diagnostics).toHaveLength(1)
		expect(context.diagnostics![0]).toMatchObject({ message: "in range", code: "E1", source: "ts" })
	})

	it("OMITS the diagnostics key entirely when none intersect", () => {
		const editor = { document: makeDocument(["a", "b"]), selection: selection(0, 0, 0, 1) }

		expect("diagnostics" in EditorUtils.getEditorContext(editor as never)!).toBe(false)
	})

	it("returns null rather than throwing when the editor misbehaves", () => {
		const editor = {
			get document(): never {
				throw new Error("editor disposed")
			},
		}

		expect(EditorUtils.getEditorContext(editor as never)).toBeNull()
	})
})
