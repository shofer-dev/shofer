// npx vitest src/components/chat/__tests__/WorkflowParamForm.widgets.spec.tsx
//
// The widget a flow parameter renders is DERIVED from its type plus its
// metadata (options, min/max, an explicit `widget`). A parameter that picks up
// the wrong widget still renders — it just collects the wrong thing — so the
// derivation is walked here, along with the typed payload each widget submits.

import { render, screen, fireEvent } from "@testing-library/react"
import { TooltipProvider } from "@radix-ui/react-tooltip"

import type { ParamField } from "@shofer/types"

import { WorkflowParamForm } from "../WorkflowParamForm"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const onSubmit = vi.fn()

const renderForm = (params: ParamField[], props: Record<string, unknown> = {}) =>
	render(
		<TooltipProvider>
			<WorkflowParamForm params={params} onSubmit={onSubmit} {...props} />
		</TooltipProvider>,
	)

const submit = () => fireEvent.click(screen.getByRole("button"))
const payload = () => JSON.parse(onSubmit.mock.calls.at(-1)![0])

beforeEach(() => vi.clearAllMocks())

describe("widget derivation", () => {
	it("renders a checkbox for a boolean, and submits a real boolean", () => {
		renderForm([{ name: "dryRun", type: "boolean" } as ParamField])

		const box = screen.getByRole("checkbox")
		expect(box).not.toBeChecked()
		fireEvent.click(box)
		submit()
		expect(payload()).toEqual({ dryRun: true })
	})

	it("renders a dropdown when a string carries options", () => {
		renderForm([{ name: "env", type: "string", options: ["dev", "prod"] } as ParamField])

		const select = screen.getByRole("combobox")
		fireEvent.change(select, { target: { value: "prod" } })
		submit()
		expect(payload()).toEqual({ env: "prod" })
	})

	it("renders radios when the field asks for them", () => {
		renderForm([{ name: "env", type: "string", options: ["dev", "prod"], widget: "radio" } as ParamField])

		const radios = screen.getAllByRole("radio")
		expect(radios).toHaveLength(2)
		fireEvent.click(radios[1])
		submit()
		expect(payload()).toEqual({ env: "prod" })
	})

	it("renders a multi-select when the field asks for checkboxes", () => {
		renderForm([{ name: "targets", type: "string", options: ["a", "b", "c"], widget: "checkbox" } as ParamField])

		const boxes = screen.getAllByRole("checkbox")
		fireEvent.click(boxes[0])
		fireEvent.click(boxes[2])
		submit()
		expect(payload().targets).toEqual(["a", "c"])

		fireEvent.click(boxes[0])
		submit()
		expect(payload().targets).toEqual(["c"])
	})

	it("renders a slider when a number declares bounds, and submits a number", () => {
		renderForm([{ name: "count", type: "number", min: 1, max: 10, default: 3 } as ParamField])

		const slider = screen.getByRole("slider")
		fireEvent.change(slider, { target: { value: "7" } })
		submit()
		expect(payload()).toEqual({ count: 7 })
	})

	it("renders a slider when the field asks for one explicitly", () => {
		renderForm([{ name: "count", type: "number", widget: "slider" } as ParamField])
		expect(screen.getByRole("slider")).toBeInTheDocument()
	})

	it("renders a plain number input for an unbounded number", () => {
		renderForm([{ name: "count", type: "number" } as ParamField])

		const input = screen.getByRole("spinbutton")
		fireEvent.change(input, { target: { value: "42" } })
		submit()
		expect(payload()).toEqual({ count: 42 })
	})

	it("submits an empty string, not zero, for a number left blank", () => {
		renderForm([{ name: "count", type: "number" } as ParamField])
		submit()
		expect(payload()).toEqual({ count: "" })
	})

	it("falls back to a textarea for a plain string", () => {
		renderForm([{ name: "note", type: "string" } as ParamField])

		const textarea = screen.getByRole("textbox")
		fireEvent.change(textarea, { target: { value: "some prose" } })
		submit()
		expect(payload()).toEqual({ note: "some prose" })
	})
})

describe("seeding", () => {
	it("seeds each widget kind from its default", () => {
		renderForm([
			{ name: "dryRun", type: "boolean", default: true } as ParamField,
			{ name: "env", type: "string", options: ["dev", "prod"], default: "prod" } as ParamField,
			{ name: "count", type: "number", min: 0, max: 10, default: 4 } as ParamField,
			{ name: "note", type: "string", default: "hello" } as ParamField,
		])

		expect(screen.getByRole("checkbox")).toBeChecked()
		expect(screen.getByRole("combobox")).toHaveValue("prod")
		expect(screen.getByRole("slider")).toHaveValue("4")
		expect(screen.getByRole("textbox")).toHaveValue("hello")
	})

	it("seeds a slider from its minimum when the default is unusable", () => {
		renderForm([{ name: "count", type: "number", min: 3, max: 9, default: "nonsense" } as ParamField])
		expect(screen.getByRole("slider")).toHaveValue("3")
	})

	it("seeds a multi-select from an array default and ignores a non-array one", () => {
		const { unmount } = renderForm([
			{ name: "t", type: "string", options: ["a", "b"], widget: "checkbox", default: ["b"] } as ParamField,
		])
		expect(screen.getAllByRole("checkbox")[1]).toBeChecked()
		unmount()

		renderForm([{ name: "t", type: "string", options: ["a", "b"], widget: "checkbox", default: "b" } as ParamField])
		expect(screen.getAllByRole("checkbox").every((b) => !(b as HTMLInputElement).checked)).toBe(true)
	})

	it("prefers the answered values over the defaults when replaying", () => {
		renderForm([{ name: "note", type: "string", default: "the default" } as ParamField], {
			isAnswered: true,
			answeredValues: { note: "what was sent" },
		})
		expect(screen.getByRole("textbox")).toHaveValue("what was sent")
	})
})

describe("the read-only replay", () => {
	it("disables every control and offers no submit button", () => {
		renderForm(
			[
				{ name: "note", type: "string", default: "x" } as ParamField,
				{ name: "dryRun", type: "boolean", default: true } as ParamField,
			],
			{ isAnswered: true },
		)
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
		expect(screen.getByRole("textbox")).toBeDisabled()
		expect(screen.getByRole("checkbox")).toBeDisabled()
	})
})

describe("submitting", () => {
	it("does nothing when no handler was supplied", () => {
		render(
			<TooltipProvider>
				<WorkflowParamForm params={[{ name: "note", type: "string" } as ParamField]} />
			</TooltipProvider>,
		)
		expect(() => submit()).not.toThrow()
	})

	it("submits everything in one payload", () => {
		renderForm([
			{ name: "note", type: "string" } as ParamField,
			{ name: "count", type: "number" } as ParamField,
			{ name: "dryRun", type: "boolean" } as ParamField,
		])

		fireEvent.change(screen.getByRole("textbox"), { target: { value: "n" } })
		fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "2" } })
		fireEvent.click(screen.getByRole("checkbox"))
		submit()

		expect(payload()).toEqual({ note: "n", count: 2, dryRun: true })
	})
})
