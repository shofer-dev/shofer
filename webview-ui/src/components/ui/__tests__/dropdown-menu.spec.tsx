// npx vitest src/components/ui/__tests__/dropdown-menu.spec.tsx
//
// The VS Code-themed wrappers around Radix's dropdown menu. Each forwards its
// ref and merges the caller's class over the theme classes — a wrapper that
// drops either breaks silently (an unstyled menu, or a Radix primitive that
// cannot position itself).

import { createRef } from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"

import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "../dropdown-menu"

const onSelect = vi.fn()

const renderMenu = (children: React.ReactNode) =>
	render(
		<DropdownMenu defaultOpen>
			<DropdownMenuTrigger>open</DropdownMenuTrigger>
			<DropdownMenuContent>{children}</DropdownMenuContent>
		</DropdownMenu>,
	)

beforeEach(() => vi.clearAllMocks())

describe("the dropdown menu wrappers", () => {
	it("renders an open menu with its items", () => {
		renderMenu(
			<DropdownMenuGroup>
				<DropdownMenuLabel>Actions</DropdownMenuLabel>
				<DropdownMenuItem onSelect={onSelect}>Do it</DropdownMenuItem>
			</DropdownMenuGroup>,
		)

		expect(screen.getByText("Actions")).toBeInTheDocument()
		fireEvent.click(screen.getByText("Do it"))
		expect(onSelect).toHaveBeenCalled()
	})

	it("keeps the caller's own class alongside the theme classes", () => {
		renderMenu(<DropdownMenuItem className="my-own-class">Do it</DropdownMenuItem>)
		const item = screen.getByText("Do it")
		expect(item.className).toContain("my-own-class")
		expect(item.className).toContain("text-vscode-dropdown-foreground")
	})

	it("indents an inset item and an inset label", () => {
		renderMenu(
			<>
				<DropdownMenuLabel inset>Inset label</DropdownMenuLabel>
				<DropdownMenuItem inset>Inset item</DropdownMenuItem>
			</>,
		)
		expect(screen.getByText("Inset label").className).toContain("pl-8")
		expect(screen.getByText("Inset item").className).toContain("pl-8")
	})

	it("renders a checkbox item, checked and unchecked", () => {
		renderMenu(
			<>
				<DropdownMenuCheckboxItem checked>On</DropdownMenuCheckboxItem>
				<DropdownMenuCheckboxItem checked={false}>Off</DropdownMenuCheckboxItem>
			</>,
		)
		expect(screen.getByText("On")).toHaveAttribute("data-state", "checked")
		expect(screen.getByText("Off")).toHaveAttribute("data-state", "unchecked")
	})

	it("renders a radio group with the selected item marked", () => {
		renderMenu(
			<DropdownMenuRadioGroup value="b">
				<DropdownMenuRadioItem value="a">A</DropdownMenuRadioItem>
				<DropdownMenuRadioItem value="b">B</DropdownMenuRadioItem>
			</DropdownMenuRadioGroup>,
		)
		expect(screen.getByText("A")).toHaveAttribute("data-state", "unchecked")
		expect(screen.getByText("B")).toHaveAttribute("data-state", "checked")
	})

	it("renders a separator and a shortcut hint", () => {
		const { container } = renderMenu(
			<>
				<DropdownMenuItem>
					Do it
					<DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
			</>,
		)
		expect(screen.getByText("⌘K").className).toContain("ml-auto")
		expect(container.ownerDocument.querySelector('[role="separator"]')).toBeTruthy()
	})

	it("merges a caller class into the separator and the shortcut too", () => {
		renderMenu(
			<>
				<DropdownMenuSeparator className="sep-class" />
				<DropdownMenuShortcut className="shortcut-class">⌘K</DropdownMenuShortcut>
			</>,
		)
		expect(document.querySelector(".sep-class")).toBeTruthy()
		expect(screen.getByText("⌘K").className).toContain("shortcut-class")
	})

	it("forwards refs to the underlying primitives", () => {
		const itemRef = createRef<HTMLDivElement>()
		const labelRef = createRef<HTMLDivElement>()
		const separatorRef = createRef<HTMLDivElement>()

		renderMenu(
			<>
				<DropdownMenuLabel ref={labelRef}>Label</DropdownMenuLabel>
				<DropdownMenuItem ref={itemRef}>Item</DropdownMenuItem>
				<DropdownMenuSeparator ref={separatorRef} />
			</>,
		)

		expect(itemRef.current).toBeInstanceOf(HTMLElement)
		expect(labelRef.current).toBeInstanceOf(HTMLElement)
		expect(separatorRef.current).toBeInstanceOf(HTMLElement)
	})

	it("renders the content into a caller-supplied container", () => {
		const container = document.createElement("div")
		container.id = "custom-portal"
		document.body.appendChild(container)

		render(
			<DropdownMenu defaultOpen>
				<DropdownMenuTrigger>open</DropdownMenuTrigger>
				<DropdownMenuContent container={container}>
					<DropdownMenuItem>Inside</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		)

		expect(container.textContent).toContain("Inside")
	})
})
