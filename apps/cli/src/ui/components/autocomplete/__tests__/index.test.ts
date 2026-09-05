import * as autocomplete from "../index.js"
import * as triggers from "../triggers/index.js"
import { AutocompleteInput } from "../AutocompleteInput.js"
import { PickerSelect } from "../PickerSelect.js"
import { useAutocompletePicker } from "../useAutocompletePicker.js"
import { createFileTrigger, toFileResult } from "../triggers/FileTrigger.js"
import { createSlashCommandTrigger, toSlashCommandResult } from "../triggers/SlashCommandTrigger.js"
import { createModeTrigger, toModeResult } from "../triggers/ModeTrigger.js"
import { createHelpTrigger } from "../triggers/HelpTrigger.js"
import { createHistoryTrigger, toHistoryResult } from "../triggers/HistoryTrigger.js"

describe("autocomplete barrels", () => {
	it("re-exports the components and hook", () => {
		expect(autocomplete.AutocompleteInput).toBe(AutocompleteInput)
		expect(autocomplete.PickerSelect).toBe(PickerSelect)
		expect(autocomplete.useAutocompletePicker).toBe(useAutocompletePicker)
	})

	it("re-exports every trigger factory through the top-level barrel", () => {
		expect(autocomplete.createFileTrigger).toBe(createFileTrigger)
		expect(autocomplete.createSlashCommandTrigger).toBe(createSlashCommandTrigger)
		expect(autocomplete.createModeTrigger).toBe(createModeTrigger)
		expect(autocomplete.createHelpTrigger).toBe(createHelpTrigger)
		expect(autocomplete.createHistoryTrigger).toBe(createHistoryTrigger)
	})

	it("re-exports every trigger factory and adapter through the triggers barrel", () => {
		expect(triggers.createFileTrigger).toBe(createFileTrigger)
		expect(triggers.toFileResult).toBe(toFileResult)
		expect(triggers.createSlashCommandTrigger).toBe(createSlashCommandTrigger)
		expect(triggers.toSlashCommandResult).toBe(toSlashCommandResult)
		expect(triggers.createModeTrigger).toBe(createModeTrigger)
		expect(triggers.toModeResult).toBe(toModeResult)
		expect(triggers.createHelpTrigger).toBe(createHelpTrigger)
		expect(triggers.createHistoryTrigger).toBe(createHistoryTrigger)
		expect(triggers.toHistoryResult).toBe(toHistoryResult)
	})
})
