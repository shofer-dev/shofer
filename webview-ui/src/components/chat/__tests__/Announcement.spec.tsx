import { render, screen } from "@/utils/test-utils"

import Announcement from "../Announcement"

vi.mock("@shofer/shared/package", () => ({
	Package: {
		version: "3.52.0",
		changelog: "## 3.52.0 — 2026-06-14\n\n### Features\n\n- A shiny new thing that landed in this release.",
	},
}))

// MarkdownBlock pulls in heavy markdown/syntax deps; render its text plainly.
vi.mock("@src/components/common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown?: string }) => <div data-testid="markdown">{markdown}</div>,
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { version?: string }) => {
			if (key === "chat:announcement.title") {
				return `Shofer ${options?.version ?? ""} Released`
			}
			if (key === "chat:announcement.noChangelog") {
				return "Release notes are unavailable for this build."
			}
			return key
		},
	}),
}))

describe("Announcement", () => {
	it("renders the announcement title with the package version", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getByText("Shofer 3.52.0 Released")).toBeInTheDocument()
	})

	it("renders the build-time changelog entry", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getByTestId("markdown")).toHaveTextContent("A shiny new thing that landed in this release.")
	})
})
