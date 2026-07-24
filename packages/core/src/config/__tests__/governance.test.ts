import { builtInModesDisabled, builtInWorkflowsDisabled } from "../governance.js"

describe("governance env flags", () => {
	const MODES_ENV = "SHOFER_DISABLE_BUILTIN_MODES"
	const WORKFLOWS_ENV = "SHOFER_DISABLE_BUILTIN_WORKFLOWS"

	let originalModes: string | undefined
	let originalWorkflows: string | undefined

	beforeEach(() => {
		originalModes = process.env[MODES_ENV]
		originalWorkflows = process.env[WORKFLOWS_ENV]
		delete process.env[MODES_ENV]
		delete process.env[WORKFLOWS_ENV]
	})

	afterEach(() => {
		if (originalModes === undefined) delete process.env[MODES_ENV]
		else process.env[MODES_ENV] = originalModes
		if (originalWorkflows === undefined) delete process.env[WORKFLOWS_ENV]
		else process.env[WORKFLOWS_ENV] = originalWorkflows
	})

	it("defaults to false when unset", () => {
		expect(builtInModesDisabled()).toBe(false)
		expect(builtInWorkflowsDisabled()).toBe(false)
	})

	it.each(["1", "true", "TRUE", "yes", "on", " True ", "On"])("treats %j as truthy (modes)", (value) => {
		process.env[MODES_ENV] = value
		expect(builtInModesDisabled()).toBe(true)
	})

	it.each(["1", "true", "yes", "on"])("treats %j as truthy (workflows)", (value) => {
		process.env[WORKFLOWS_ENV] = value
		expect(builtInWorkflowsDisabled()).toBe(true)
	})

	it.each(["0", "false", "no", "off", "", "disabled", "2"])("treats %j as falsy (modes)", (value) => {
		process.env[MODES_ENV] = value
		expect(builtInModesDisabled()).toBe(false)
	})

	it("reads the two flags independently", () => {
		process.env[MODES_ENV] = "1"
		expect(builtInModesDisabled()).toBe(true)
		expect(builtInWorkflowsDisabled()).toBe(false)
	})
})
