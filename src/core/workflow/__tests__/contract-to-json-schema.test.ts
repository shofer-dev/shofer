/**
 * Unit tests for contractToJsonSchema() and its integration with
 * getNativeTools()'s applyCompletionSchema().
 *
 * These tests verify Lever 1 of output_contract_enforcement.md:
 * the per-task attempt_completion schema swap for workflow output contracts.
 *
 * The mock conformance harness proves "didn't break"; these
 * deterministic, network-free tests prove the feature WORKS.
 */

import { contractToJsonSchema, type OutputSchema } from "../slang-ast"
import { getNativeTools } from "../../prompts/tools/native-tools"

describe("contractToJsonSchema", () => {
	test("single string field", () => {
		const schema: OutputSchema = { fields: [{ name: "summary", fieldType: "string" }] }
		const result = contractToJsonSchema(schema)
		expect(result).toEqual({
			type: "object",
			properties: { summary: { type: "string" } },
			required: ["summary"],
			additionalProperties: false,
		})
	})

	test("multiple fields of mixed types", () => {
		const schema: OutputSchema = {
			fields: [
				{ name: "summary", fieldType: "string" },
				{ name: "confidence", fieldType: "number" },
				{ name: "tags", fieldType: "string" },
			],
		}
		const result = contractToJsonSchema(schema)
		expect(result).toEqual({
			type: "object",
			properties: {
				summary: { type: "string" },
				confidence: { type: "number" },
				tags: { type: "string" },
			},
			required: ["summary", "confidence", "tags"],
			additionalProperties: false,
		})
	})

	test("boolean field", () => {
		const schema: OutputSchema = { fields: [{ name: "verified", fieldType: "boolean" }] }
		const result = contractToJsonSchema(schema)
		expect(result).toEqual({
			type: "object",
			properties: { verified: { type: "boolean" } },
			required: ["verified"],
			additionalProperties: false,
		})
	})

	test("empty fields array", () => {
		const schema: OutputSchema = { fields: [] }
		const result = contractToJsonSchema(schema)
		expect(result).toEqual({
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		})
	})

	test("all required, no optional", () => {
		// Every fieldType in OutputField should be mapped to required.
		// The post-hoc validator in collectStakeResults() checks all
		// fields are present, so the schema must match.
		const schema: OutputSchema = {
			fields: [
				{ name: "a", fieldType: "string" },
				{ name: "b", fieldType: "number" },
				{ name: "c", fieldType: "boolean" },
			],
		}
		const result = contractToJsonSchema(schema)
		expect(result.required).toEqual(["a", "b", "c"])
		expect(result.additionalProperties).toBe(false)
	})
})

describe("getNativeTools with completionSchema", () => {
	test("without completionSchema: default result:string", () => {
		const tools = getNativeTools({ supportsImages: false })
		const ac = tools.find((t) => (t as any).function?.name === "attempt_completion")
		expect(ac).toBeDefined()
		const params = (ac as any).function.parameters
		expect(params.properties.result.type).toBe("string")
	})

	test("with completionSchema: result replaced by contract object", () => {
		const contract = contractToJsonSchema({
			fields: [
				{ name: "summary", fieldType: "string" },
				{ name: "confidence", fieldType: "number" },
			],
		})
		const tools = getNativeTools({ supportsImages: false, completionSchema: contract })
		const ac = tools.find((t) => (t as any).function?.name === "attempt_completion")
		expect(ac).toBeDefined()
		const params = (ac as any).function.parameters

		// The top-level schema still has result + rating + feedback
		expect(params.required).toContain("result")
		expect(params.required).toContain("rating")
		expect(params.additionalProperties).toBe(false)

		// The result parameter IS the contract schema (not a string)
		const resultParam = params.properties.result
		expect(resultParam.type).toBe("object")
		expect(resultParam.properties.summary).toEqual({ type: "string" })
		expect(resultParam.properties.confidence).toEqual({ type: "number" })
		expect(resultParam.required).toEqual(["summary", "confidence"])
		expect(resultParam.additionalProperties).toBe(false)
	})

	test("strict flag preserved on schema-swapped tool", () => {
		const contract = contractToJsonSchema({
			fields: [{ name: "summary", fieldType: "string" }],
		})
		const tools = getNativeTools({ supportsImages: false, completionSchema: contract })
		const ac = tools.find((t) => (t as any).function?.name === "attempt_completion")
		expect((ac as any).function.strict).toBe(true)
	})
})
