// npx vitest src/components/common/__tests__/Thumbnails.spec.tsx
//
// The attachment strip. Deletability is decided by whether a setter was handed
// in — a read-only transcript passes none — and the delete affordance only
// exists under the pointer, so the hover state is part of the contract rather
// than decoration.

import { render, screen, fireEvent } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import Thumbnails from "../Thumbnails"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const postMessage = vi.mocked(vscode.postMessage)

const images = ["data:image/png;base64,AAA", "data:image/png;base64,BBB"]

const thumb = (index: number) => screen.getByAltText(`Thumbnail ${index + 1}`)
const tile = (index: number) => thumb(index).parentElement as HTMLElement
const closeButton = () => document.querySelector(".codicon-close")?.parentElement as HTMLElement | undefined

beforeEach(() => vi.clearAllMocks())

describe("Thumbnails", () => {
	it("renders one tile per image", () => {
		render(<Thumbnails images={images} />)
		expect(screen.getAllByRole("img")).toHaveLength(2)
	})

	it("renders nothing for an empty list", () => {
		render(<Thumbnails images={[]} />)
		expect(screen.queryAllByRole("img")).toHaveLength(0)
	})

	it("opens an image in the editor when clicked", () => {
		render(<Thumbnails images={images} />)
		fireEvent.click(thumb(1))
		expect(postMessage).toHaveBeenCalledWith({ type: "openImage", text: images[1] })
	})

	it("offers no delete affordance without a setter", () => {
		render(<Thumbnails images={images} />)
		fireEvent.mouseEnter(tile(0))
		expect(closeButton()).toBeUndefined()
	})

	it("reveals the delete affordance on hover when editable", () => {
		render(<Thumbnails images={images} setImages={vi.fn()} />)
		expect(closeButton()).toBeUndefined()

		fireEvent.mouseEnter(tile(0))
		expect(closeButton()).toBeTruthy()

		fireEvent.mouseLeave(tile(0))
		expect(closeButton()).toBeUndefined()
	})

	it("removes by position, leaving the others in order", () => {
		let current = images
		const setImages = vi.fn((fn: (prev: string[]) => string[]) => {
			current = fn(current)
		})
		render(<Thumbnails images={images} setImages={setImages as never} />)

		fireEvent.mouseEnter(tile(1))
		fireEvent.click(closeButton()!)
		expect(current).toEqual([images[0]])
	})

	it("reports its rendered height to the composer", () => {
		const onHeightChange = vi.fn()
		render(<Thumbnails images={images} onHeightChange={onHeightChange} />)
		expect(onHeightChange).toHaveBeenCalled()
	})

	it("falls back to the measured box when clientHeight reads zero", () => {
		// jsdom reports 0 for clientHeight, which is exactly the browser quirk
		// the component guards against, so the bounding box is what answers.
		const onHeightChange = vi.fn()
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 42 } as never)

		render(<Thumbnails images={images} onHeightChange={onHeightChange} />)
		expect(onHeightChange).toHaveBeenCalledWith(42)
		vi.restoreAllMocks()
	})
})
