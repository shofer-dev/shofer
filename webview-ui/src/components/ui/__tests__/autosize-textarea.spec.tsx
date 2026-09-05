// npx vitest src/components/ui/__tests__/autosize-textarea.spec.tsx

import { createRef } from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"

import { AutosizeTextarea, type AutosizeTextAreaRef } from "../autosize-textarea"

/** jsdom reports `scrollHeight` as 0; the hook's whole job is to read it. */
const withScrollHeight = (value: number) =>
	vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(value)

afterEach(() => vi.restoreAllMocks())

describe("AutosizeTextarea", () => {
	it("pins the min and max height on first render", () => {
		withScrollHeight(40)
		render(<AutosizeTextarea minHeight={30} maxHeight={200} value="" onChange={vi.fn()} />)

		const el = screen.getByRole("textbox") as HTMLTextAreaElement
		expect(el.style.minHeight).toBe("36px") // minHeight + the 6px border offset
		expect(el.style.maxHeight).toBe("200px")
	})

	it("grows to the content's scroll height", () => {
		withScrollHeight(120)
		render(<AutosizeTextarea minHeight={30} maxHeight={400} value="lots of text" onChange={vi.fn()} />)
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).style.height).toBe("126px")
	})

	it("stops growing at the maximum", () => {
		withScrollHeight(999)
		render(<AutosizeTextarea minHeight={30} maxHeight={100} value="lots" onChange={vi.fn()} />)
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).style.height).toBe("100px")
	})

	it("does not set a maximum when it is not above the minimum", () => {
		withScrollHeight(40)
		render(<AutosizeTextarea minHeight={100} maxHeight={50} value="" onChange={vi.fn()} />)
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).style.maxHeight).toBe("")
	})

	it("resizes as the user types, and forwards the change", () => {
		const onChange = vi.fn()
		const scrollHeight = withScrollHeight(40)
		render(<AutosizeTextarea minHeight={30} maxHeight={400} value="a" onChange={onChange} />)

		const el = screen.getByRole("textbox") as HTMLTextAreaElement
		scrollHeight.mockReturnValue(90)
		fireEvent.change(el, { target: { value: "a\nb\nc" } })

		expect(onChange).toHaveBeenCalled()
		expect(el.style.height).toBe("96px")
	})

	it("survives a change with no handler attached", () => {
		withScrollHeight(40)
		render(<AutosizeTextarea minHeight={30} maxHeight={400} value="a" readOnly />)
		expect(() => fireEvent.change(screen.getByRole("textbox"), { target: { value: "b" } })).not.toThrow()
	})

	it("exposes the element and its bounds through the imperative handle", () => {
		withScrollHeight(40)
		const ref = createRef<AutosizeTextAreaRef>()
		render(<AutosizeTextarea ref={ref} minHeight={30} maxHeight={400} value="" onChange={vi.fn()} />)

		expect(ref.current!.textArea).toBe(screen.getByRole("textbox"))
		expect(ref.current!.minHeight).toBe(30)
		expect(ref.current!.maxHeight).toBe(400)
		expect(() => (ref.current as unknown as { focus: () => void }).focus()).not.toThrow()
	})
})
