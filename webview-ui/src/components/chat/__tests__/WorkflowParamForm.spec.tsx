import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { TooltipProvider } from "@radix-ui/react-tooltip"

import type { ParamField } from "@shofer/types"

import { WorkflowParamForm } from "../WorkflowParamForm"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const renderForm = (params: ParamField[], onSubmit = vi.fn(), isAnswered = false) => {
	render(
		<TooltipProvider>
			<WorkflowParamForm params={params} onSubmit={onSubmit} isAnswered={isAnswered} />
		</TooltipProvider>,
	)
	return onSubmit
}

describe("WorkflowParamForm", () => {
	it("renders a typed widget per param and submits a typed JSON payload", () => {
		const params: ParamField[] = [
			{ name: "feature", type: "string", default: "" },
			{ name: "count", type: "number", default: 0 },
			{ name: "enabled", type: "boolean", default: false },
		]
		const onSubmit = renderForm(params)

		const textInput = screen.getByLabelText(/^feature/) as HTMLInputElement
		const numberInput = screen.getByLabelText(/^count/) as HTMLInputElement
		const checkbox = screen.getByLabelText(/^enabled/) as HTMLInputElement
		expect(textInput.type).toBe("textarea") // string params render as a multiline textarea
		expect(numberInput.type).toBe("number")
		expect(checkbox.type).toBe("checkbox")

		fireEvent.change(textInput, { target: { value: "dark mode" } })
		fireEvent.change(numberInput, { target: { value: "42" } })
		fireEvent.click(checkbox)

		fireEvent.click(screen.getByRole("button", { name: "chat:sendMessage" }))

		expect(onSubmit).toHaveBeenCalledTimes(1)
		expect(JSON.parse(onSubmit.mock.calls[0][0])).toEqual({
			feature: "dark mode",
			count: 42, // coerced to number
			enabled: true, // coerced to boolean
		})
	})

	it("seeds fields from defaults and submits Ctrl+Enter on a textarea field", () => {
		const params: ParamField[] = [{ name: "feature", type: "string", default: "hello" }]
		const onSubmit = renderForm(params)
		const input = screen.getByLabelText(/^feature/) as HTMLTextAreaElement
		expect(input.value).toBe("hello")
		// Plain Enter inserts a newline in the textarea; submit is Ctrl/Cmd+Enter.
		fireEvent.keyDown(input, { key: "Enter", ctrlKey: true })
		expect(onSubmit).toHaveBeenCalledWith(JSON.stringify({ feature: "hello" }))
	})

	it("submits the seeded default when a field is left untouched", () => {
		const params: ParamField[] = [{ name: "count", type: "number", default: 7 }]
		const onSubmit = renderForm(params)
		expect((screen.getByLabelText(/^count/) as HTMLInputElement).value).toBe("7")
		fireEvent.click(screen.getByRole("button", { name: "chat:sendMessage" }))
		expect(JSON.parse(onSubmit.mock.calls[0][0])).toEqual({ count: 7 })
	})

	it("renders read-only with no submit button when already answered", () => {
		const params: ParamField[] = [{ name: "feature", type: "string", default: "x" }]
		renderForm(params, vi.fn(), true)
		expect((screen.getByLabelText(/^feature/) as HTMLInputElement).disabled).toBe(true)
		expect(screen.queryByRole("button", { name: "chat:sendMessage" })).toBeNull()
	})

	it("seeds the read-only display from answeredValues (reload replay)", () => {
		const params: ParamField[] = [
			{ name: "feature", type: "string", default: "" },
			{ name: "enabled", type: "boolean", default: false },
		]
		render(
			<TooltipProvider>
				<WorkflowParamForm
					params={params}
					isAnswered={true}
					answeredValues={{ feature: "dark mode", enabled: true }}
				/>
			</TooltipProvider>,
		)
		expect((screen.getByLabelText(/^feature/) as HTMLInputElement).value).toBe("dark mode")
		expect((screen.getByLabelText(/^enabled/) as HTMLInputElement).checked).toBe(true)
		expect(screen.queryByRole("button", { name: "chat:sendMessage" })).toBeNull()
	})
})
