// npx vitest src/components/welcome/__tests__/ShoferHero.spec.tsx
//
// The welcome hero. Two things are load-bearing and both are easy to break
// silently: the logo is drawn as a THEME-TINTED MASK (the <img> underneath is
// deliberately transparent), and its URL comes from the host-injected base URI
// rather than a bundled asset path.

import { render, screen, fireEvent } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import ShoferHero from "../ShoferHero"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const postMessage = vi.mocked(vscode.postMessage)

beforeEach(() => {
	vi.clearAllMocks()
	delete (window as unknown as Record<string, unknown>).IMAGES_BASE_URI
})

describe("ShoferHero", () => {
	it("opens the project site in the user's browser, not the webview", () => {
		render(<ShoferHero />)
		fireEvent.click(screen.getByRole("link", { name: "Visit shofer.dev" }))

		expect(postMessage).toHaveBeenCalledWith({ type: "openExternal", url: "https://shofer.dev/" })
	})

	it("builds the logo URL from the host-injected base URI", () => {
		;(window as unknown as Record<string, unknown>).IMAGES_BASE_URI = "vscode-webview://host/images"
		render(<ShoferHero />)

		expect(screen.getByAltText("Shofer logo")).toHaveAttribute("src", "vscode-webview://host/images/shofer.svg")
	})

	it("degrades to a bare relative path when the host injected none", () => {
		render(<ShoferHero />)
		expect(screen.getByAltText("Shofer logo")).toHaveAttribute("src", "/shofer.svg")
	})

	it("tints the logo through a mask, keeping the image itself invisible", () => {
		render(<ShoferHero />)
		const image = screen.getByAltText("Shofer logo")

		expect(image).toHaveClass("opacity-0")
		expect((image.parentElement as HTMLElement).style.maskImage).toContain("shofer.svg")
		expect((image.parentElement as HTMLElement).getAttribute("style")).toContain("var(--vscode-foreground)")
	})
})
