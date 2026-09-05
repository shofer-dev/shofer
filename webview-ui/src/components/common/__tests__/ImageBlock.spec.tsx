// npx vitest src/components/common/__tests__/ImageBlock.spec.tsx
//
// The adapter between two image shapes a row can carry — the explicit
// uri/path pair, and the legacy data/path pair Mermaid still produces — and the
// single viewer both end up in.

import { render, screen } from "@/utils/test-utils"

import ImageBlock from "../ImageBlock"

vi.mock("../ImageViewer", () => ({
	ImageViewer: ({ imageUri, imagePath, alt, showControls }: any) => (
		<div
			data-testid="image-viewer"
			data-uri={imageUri}
			data-path={imagePath ?? ""}
			data-alt={alt}
			data-controls={String(showControls)}
		/>
	),
}))

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe("ImageBlock", () => {
	it("renders the explicit uri/path pair", () => {
		render(<ImageBlock imageUri="vscode-webview://x/a.png" imagePath="out/a.png" />)

		const viewer = screen.getByTestId("image-viewer")
		expect(viewer).toHaveAttribute("data-uri", "vscode-webview://x/a.png")
		expect(viewer).toHaveAttribute("data-path", "out/a.png")
		expect(viewer).toHaveAttribute("data-controls", "true")
	})

	it("prefers the explicit uri when both shapes are present", () => {
		render(<ImageBlock imageUri="uri://new" imagePath="new.png" imageData="data:old" path="old.png" />)

		const viewer = screen.getByTestId("image-viewer")
		expect(viewer).toHaveAttribute("data-uri", "uri://new")
		expect(viewer).toHaveAttribute("data-path", "new.png")
	})

	it("falls back to the legacy data/path pair", () => {
		render(<ImageBlock imageData="data:image/png;base64,AAA" path="diagram.png" />)

		const viewer = screen.getByTestId("image-viewer")
		expect(viewer).toHaveAttribute("data-uri", "data:image/png;base64,AAA")
		expect(viewer).toHaveAttribute("data-path", "diagram.png")
	})

	it("renders a uri with no path at all", () => {
		render(<ImageBlock imageUri="uri://only" />)
		expect(screen.getByTestId("image-viewer")).toHaveAttribute("data-path", "")
	})

	it("renders nothing when neither shape carries an image", () => {
		const { container } = render(<ImageBlock imagePath="a.png" />)
		expect(container).toBeEmptyDOMElement()
	})
})
