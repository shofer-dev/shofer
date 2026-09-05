import { useState } from "react"
import { render } from "ink-testing-library"

import { MultilineTextInput, type MultilineTextInputProps } from "../MultilineTextInput.js"

const ESC = "\u001B"

/**
 * The exact byte sequences Ink's keypress parser turns into the `Key` flags
 * this component branches on. Established against Ink 6 rather than assumed:
 * a bare `[A` (no ESC) arrives as literal text, not as an arrow.
 */
const KEY = {
	up: `${ESC}[A`,
	down: `${ESC}[B`,
	right: `${ESC}[C`,
	left: `${ESC}[D`,
	enter: "\r",
	/** ESC+CR — Ink reports `input === "\r"` with `key.return` false, the Option+Enter shape. */
	altEnter: `${ESC}\r`,
	backspace: "\u0008",
	del: "\u007F",
	tab: "\t",
	escape: ESC,
	ctrlC: "\u0003",
} as const

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

type HarnessProps = Omit<MultilineTextInputProps, "value" | "onChange"> & {
	initialValue?: string
	onChange?: (value: string) => void
}

/**
 * A controlled parent, because the component keeps its cursor internally but
 * pushes every text edit up through `onChange` — driving it uncontrolled would
 * test a state machine the app never runs.
 */
function Harness({ initialValue = "", onChange, ...rest }: HarnessProps) {
	const [value, setValue] = useState(initialValue)
	return (
		<MultilineTextInput
			{...rest}
			value={value}
			onChange={(next) => {
				setValue(next)
				onChange?.(next)
			}}
		/>
	)
}

/** Ink subscribes to stdin from an effect; give that a pass before writing. */
async function renderInput(props: HarnessProps = {}) {
	const result = render(<Harness {...props} />)
	await tick()
	return {
		...result,
		async press(sequence: string) {
			result.stdin.write(sequence)
			await tick()
		},
	}
}

describe("MultilineTextInput", () => {
	describe("rendering", () => {
		it("renders the prompt on the first row", async () => {
			const { lastFrame } = await renderInput({ prompt: "> " })
			expect(lastFrame()).toContain(">")
		})

		it("renders a custom prompt", async () => {
			const { lastFrame } = await renderInput({ prompt: "$$ " })
			expect(lastFrame()).toContain("$$")
		})

		it("renders the placeholder when empty and inactive", async () => {
			const { lastFrame } = await renderInput({ placeholder: "Type here…", isActive: false })
			expect(lastFrame()).toContain("Type here…")
		})

		it("does not render the placeholder while active", async () => {
			const { lastFrame } = await renderInput({ placeholder: "Type here…", isActive: true })
			expect(lastFrame()).not.toContain("Type here…")
		})

		it("renders the current value", async () => {
			const { lastFrame } = await renderInput({ initialValue: "hello world" })
			expect(lastFrame()).toContain("hello world")
		})

		it("renders every logical line", async () => {
			const { lastFrame } = await renderInput({ initialValue: "one\ntwo\nthree" })
			const output = lastFrame()

			expect(output).toContain("one")
			expect(output).toContain("two")
			expect(output).toContain("three")
		})

		it("keeps a blank line occupying a row", async () => {
			const { lastFrame } = await renderInput({ initialValue: "a\n\nb" })
			expect((lastFrame() ?? "").split("\n")).toHaveLength(3)
		})

		it("hides the cursor when showCursor is false", async () => {
			const { lastFrame } = await renderInput({ initialValue: "abc", showCursor: false })
			expect(lastFrame()).toContain("abc")
		})

		it("hides the cursor when inactive", async () => {
			const { lastFrame } = await renderInput({ initialValue: "abc", isActive: false })
			expect(lastFrame()).toContain("abc")
		})
	})

	describe("line wrapping", () => {
		it("leaves a short line on one row when columns is set", async () => {
			const { lastFrame } = await renderInput({ initialValue: "short", columns: 40 })
			expect((lastFrame() ?? "").split("\n")).toHaveLength(1)
		})

		it("wraps a long line at a word boundary", async () => {
			const { lastFrame } = await renderInput({
				initialValue: "alpha bravo charlie delta echo foxtrot",
				columns: 20,
				showCursor: false,
			})
			const rows = (lastFrame() ?? "").split("\n")

			expect(rows.length).toBeGreaterThan(1)
			// Word-boundary wrapping keeps words intact across the break.
			expect(lastFrame()).toContain("alpha")
			expect(lastFrame()).toContain("foxtrot")
		})

		it("breaks mid-word when there is no space to break on", async () => {
			const { lastFrame } = await renderInput({
				initialValue: "x".repeat(60),
				columns: 20,
				showCursor: false,
			})
			expect((lastFrame() ?? "").split("\n").length).toBeGreaterThan(1)
		})

		it("does not wrap into visual rows when columns is omitted", async () => {
			const { lastFrame } = await renderInput({
				initialValue: "y".repeat(200),
				showCursor: false,
				prompt: "> ",
			})

			// Ink still folds the frame at the test terminal's own width, so
			// count the prompt instead: one visual row means one prompt.
			expect((lastFrame() ?? "").match(/>/g) ?? []).toHaveLength(1)
		})

		it("only prints the prompt on the first visual row of a wrapped line", async () => {
			const { lastFrame } = await renderInput({
				initialValue: "z".repeat(60),
				columns: 20,
				prompt: "> ",
				showCursor: false,
			})
			const prompts = (lastFrame() ?? "").match(/>/g) ?? []
			expect(prompts).toHaveLength(1)
		})

		it("tolerates a columns value narrower than the prompt", async () => {
			const { lastFrame } = await renderInput({ initialValue: "abcdef", columns: 1, prompt: ">>>> " })
			expect(lastFrame()).toBeDefined()
		})

		it("suppresses the trailing cursor cell when it would overflow the row", async () => {
			// Cursor sits at the end of a row exactly as wide as the space left
			// after the prompt, so rendering an extra cell would push past `columns`.
			const { lastFrame } = await renderInput({ initialValue: "abcdefgh", columns: 10, prompt: "> " })
			expect(lastFrame()).toContain("abcdefgh")
		})
	})

	describe("character input", () => {
		it("appends typed characters", async () => {
			const onChange = vi.fn()
			const { press, lastFrame } = await renderInput({ onChange })

			await press("h")
			await press("i")

			expect(onChange).toHaveBeenLastCalledWith("hi")
			expect(lastFrame()).toContain("hi")
		})

		it("accepts a pasted multi-character chunk", async () => {
			const onChange = vi.fn()
			const { press } = await renderInput({ onChange })

			await press("pasted")

			expect(onChange).toHaveBeenLastCalledWith("pasted")
		})

		it("normalizes CRLF in pasted text to LF", async () => {
			const onChange = vi.fn()
			const { press } = await renderInput({ onChange })

			await press("a\r\nb")

			expect(onChange).toHaveBeenLastCalledWith("a\nb")
		})

		it("inserts at the cursor rather than at the end", async () => {
			const onChange = vi.fn()
			const { press } = await renderInput({ initialValue: "ac", onChange })

			await press(KEY.left)
			await press("b")

			expect(onChange).toHaveBeenLastCalledWith("abc")
		})

		it("ignores input entirely when inactive", async () => {
			const onChange = vi.fn()
			const { press } = await renderInput({ isActive: false, onChange })

			await press("x")

			expect(onChange).not.toHaveBeenCalled()
		})
	})

	describe("deletion", () => {
		it("removes the character before the cursor on backspace", async () => {
			const onChange = vi.fn()
			const { press } = await renderInput({ initialValue: "abc", onChange })

			await press(KEY.backspace)

			expect(onChange).toHaveBeenLastCalledWith("ab")
		})

		it("removes the character before the cursor on delete", async () => {
			const onChange = vi.fn()
			const { press } = await renderInput({ initialValue: "abc", onChange })

			await press(KEY.del)

			expect(onChange).toHaveBeenLastCalledWith("ab")
		})

		it("does nothing when the cursor is already at the start", async () => {
			const onChange = vi.fn()
			const { press } = await renderInput({ initialValue: "abc", onChange })

			await press(KEY.left)
			await press(KEY.left)
			await press(KEY.left)
			await press(KEY.backspace)

			expect(onChange).not.toHaveBeenCalled()
		})

		it("merges lines when backspacing over a newline", async () => {
			const onChange = vi.fn()
			const { press } = await renderInput({ initialValue: "ab\ncd", onChange })

			await press(KEY.left)
			await press(KEY.left)
			await press(KEY.backspace)

			expect(onChange).toHaveBeenLastCalledWith("abcd")
		})
	})

	describe("submit and escape", () => {
		it("submits the current value on enter", async () => {
			const onSubmit = vi.fn()
			const { press } = await renderInput({ initialValue: "send me", onSubmit })

			await press(KEY.enter)

			expect(onSubmit).toHaveBeenCalledWith("send me")
		})

		it("tolerates enter with no onSubmit handler", async () => {
			const { press, lastFrame } = await renderInput({ initialValue: "x" })

			await press(KEY.enter)

			expect(lastFrame()).toContain("x")
		})

		it("reports escape", async () => {
			const onEscape = vi.fn()
			const { press } = await renderInput({ initialValue: "abc", onEscape })

			await press(KEY.escape)

			expect(onEscape).toHaveBeenCalled()
		})

		it("tolerates escape with no onEscape handler", async () => {
			const onChange = vi.fn()
			const { press } = await renderInput({ initialValue: "abc", onChange })

			await press(KEY.escape)

			expect(onChange).not.toHaveBeenCalled()
		})

		it("inserts a newline on Option+Enter rather than submitting", async () => {
			const onChange = vi.fn()
			const onSubmit = vi.fn()
			const { press } = await renderInput({ initialValue: "ab", onChange, onSubmit })

			await press(KEY.altEnter)

			expect(onChange).toHaveBeenLastCalledWith("ab\n")
			expect(onSubmit).not.toHaveBeenCalled()
		})

		it("ignores tab", async () => {
			const onChange = vi.fn()
			const onSubmit = vi.fn()
			const { press } = await renderInput({ initialValue: "ab", onChange, onSubmit })

			await press(KEY.tab)

			expect(onChange).not.toHaveBeenCalled()
			expect(onSubmit).not.toHaveBeenCalled()
		})

		it("passes a global shortcut through untouched", async () => {
			const onChange = vi.fn()
			const onSubmit = vi.fn()
			const { press } = await renderInput({ initialValue: "ab", onChange, onSubmit })

			await press(KEY.ctrlC)

			expect(onChange).not.toHaveBeenCalled()
			expect(onSubmit).not.toHaveBeenCalled()
		})
	})

	describe("cursor navigation", () => {
		it("clamps the cursor at the start on repeated left", async () => {
			const onChange = vi.fn()
			const { press } = await renderInput({ initialValue: "ab", onChange })

			await press(KEY.left)
			await press(KEY.left)
			await press(KEY.left)
			await press("X")

			expect(onChange).toHaveBeenLastCalledWith("Xab")
		})

		it("clamps the cursor at the end on repeated right", async () => {
			const onChange = vi.fn()
			const { press } = await renderInput({ initialValue: "ab", onChange })

			await press(KEY.left)
			await press(KEY.right)
			await press(KEY.right)
			await press("X")

			expect(onChange).toHaveBeenLastCalledWith("abX")
		})

		it("moves the cursor up a line", async () => {
			const onChange = vi.fn()
			const { press } = await renderInput({ initialValue: "abc\ndef", onChange })

			await press(KEY.up)
			await press("X")

			// Column 3 on line 0 is the end of "abc".
			expect(onChange).toHaveBeenLastCalledWith("abcX\ndef")
		})

		it("moves the cursor down a line, clamping the column", async () => {
			const onChange = vi.fn()
			const { press } = await renderInput({ initialValue: "abcdef\ngh", onChange })

			await press(KEY.up) // to line 0, column 2 (end of "gh" clamped up)
			await press(KEY.down)
			await press("X")

			expect(onChange).toHaveBeenLastCalledWith("abcdef\nghX")
		})

		it("reports up at the first line instead of moving", async () => {
			const onUpAtFirstLine = vi.fn()
			const { press } = await renderInput({ initialValue: "one line", onUpAtFirstLine })

			await press(KEY.up)

			expect(onUpAtFirstLine).toHaveBeenCalled()
		})

		it("reports down at the last line instead of moving", async () => {
			const onDownAtLastLine = vi.fn()
			const { press } = await renderInput({ initialValue: "one line", onDownAtLastLine })

			await press(KEY.down)

			expect(onDownAtLastLine).toHaveBeenCalled()
		})

		it("tolerates up at the first line with no handler", async () => {
			const onChange = vi.fn()
			const { press } = await renderInput({ initialValue: "one", onChange })

			await press(KEY.up)

			expect(onChange).not.toHaveBeenCalled()
		})

		it("tolerates down at the last line with no handler", async () => {
			const onChange = vi.fn()
			const { press } = await renderInput({ initialValue: "one", onChange })

			await press(KEY.down)

			expect(onChange).not.toHaveBeenCalled()
		})

		it("ignores every arrow when showCursor is false", async () => {
			const onUpAtFirstLine = vi.fn()
			const onDownAtLastLine = vi.fn()
			const onChange = vi.fn()
			const { press } = await renderInput({
				initialValue: "ab",
				showCursor: false,
				onUpAtFirstLine,
				onDownAtLastLine,
				onChange,
			})

			await press(KEY.up)
			await press(KEY.down)
			await press(KEY.left)
			await press(KEY.right)
			await press("X")

			expect(onUpAtFirstLine).not.toHaveBeenCalled()
			expect(onDownAtLastLine).not.toHaveBeenCalled()
			// The cursor never moved, so the character lands at the initial end.
			expect(onChange).toHaveBeenLastCalledWith("abX")
		})
	})

	describe("external value changes", () => {
		it("clamps a cursor left past the end of a shortened value", async () => {
			function Shrinking() {
				const [value, setValue] = useState("a long starting value")
				return (
					<>
						<MultilineTextInput
							value={value}
							onChange={setValue}
							onEscape={() => setValue("hi")}
							prompt="> "
						/>
					</>
				)
			}

			const { stdin, lastFrame } = render(<Shrinking />)
			await tick()
			stdin.write(ESC) // the harness shrinks the value on escape
			await tick()

			expect(lastFrame()).toContain("hi")
		})
	})
})
