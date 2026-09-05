// npx vitest src/components/common/__tests__/MermaidActionButtons.spec.tsx
//
// The diagram toolbar renders in two arrangements — the inline row a chat
// message carries, and the zoom-capable row the fullscreen viewer uses — and
// the zoom arrangement is gated on ALL of its handlers being present, not just
// the flag.

import { render, screen, fireEvent } from "@/utils/test-utils"

import { MermaidActionButtons } from "../MermaidActionButtons"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const handlers = () => ({
	onCopy: vi.fn(),
	onViewCode: vi.fn(),
	onZoom: vi.fn(),
	onZoomIn: vi.fn(),
	onZoomOut: vi.fn(),
	onSave: vi.fn(),
	onClose: vi.fn(),
})

const button = (icon: string) => document.querySelector(`.codicon-${icon}`)?.closest("button") as HTMLButtonElement

describe("the inline arrangement", () => {
	it("shows view-code and copy always", () => {
		const h = handlers()
		render(<MermaidActionButtons onCopy={h.onCopy} onViewCode={h.onViewCode} copyFeedback={false} />)

		expect(button("code")).toBeTruthy()
		expect(button("copy")).toBeTruthy()
		expect(button("zoom-in")).toBeFalsy()
		expect(button("save")).toBeFalsy()
		expect(button("close")).toBeFalsy()
	})

	it("adds each optional action only when its handler exists", () => {
		const h = handlers()
		render(
			<MermaidActionButtons
				onCopy={h.onCopy}
				onViewCode={h.onViewCode}
				onZoom={h.onZoom}
				onSave={h.onSave}
				onClose={h.onClose}
				copyFeedback={false}
			/>,
		)

		fireEvent.click(button("zoom-in"))
		fireEvent.click(button("save"))
		fireEvent.click(button("close"))
		expect(h.onZoom).toHaveBeenCalled()
		expect(h.onSave).toHaveBeenCalled()
		expect(h.onClose).toHaveBeenCalled()
	})

	it("views the code without letting the click reach the diagram", () => {
		const h = handlers()
		const onParentClick = vi.fn()
		render(
			<div onClick={onParentClick}>
				<MermaidActionButtons onCopy={h.onCopy} onViewCode={h.onViewCode} copyFeedback={false} />
			</div>,
		)

		fireEvent.click(button("code"))
		expect(h.onViewCode).toHaveBeenCalled()
		expect(onParentClick).not.toHaveBeenCalled()
	})

	it("swaps the copy icon for a tick while the feedback window is open", () => {
		const h = handlers()
		render(<MermaidActionButtons onCopy={h.onCopy} onViewCode={h.onViewCode} copyFeedback />)

		expect(button("check")).toBeTruthy()
		expect(button("copy")).toBeFalsy()
	})
})

describe("the zoom arrangement", () => {
	it("replaces the plain zoom button with the zoom controls", () => {
		const h = handlers()
		render(
			<MermaidActionButtons
				onCopy={h.onCopy}
				onViewCode={h.onViewCode}
				onZoomIn={h.onZoomIn}
				onZoomOut={h.onZoomOut}
				zoomLevel={1.5}
				showZoomControls
				copyFeedback={false}
			/>,
		)

		expect(screen.getByText("150%")).toBeInTheDocument()
		expect(button("save")).toBeFalsy()
	})

	it("falls back to the inline row when a zoom handler is missing", () => {
		// The flag alone is not enough: without both handlers AND a level there
		// is nothing for the controls to show.
		const h = handlers()
		render(
			<MermaidActionButtons
				onCopy={h.onCopy}
				onViewCode={h.onViewCode}
				onZoomIn={h.onZoomIn}
				showZoomControls
				copyFeedback={false}
			/>,
		)

		expect(screen.queryByText(/%$/)).not.toBeInTheDocument()
	})

	it("falls back when the level is unknown", () => {
		const h = handlers()
		render(
			<MermaidActionButtons
				onCopy={h.onCopy}
				onViewCode={h.onViewCode}
				onZoomIn={h.onZoomIn}
				onZoomOut={h.onZoomOut}
				showZoomControls
				copyFeedback={false}
			/>,
		)

		expect(screen.queryByText(/%$/)).not.toBeInTheDocument()
	})
})
