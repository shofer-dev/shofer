// npx vitest src/tools/helpers/__tests__/coerceToolArgs.spec.ts

import { parametersSchema as z } from "@shofer/types"

import { coerceCustomToolArgs } from "../coerceToolArgs.js"

/**
 * The rule under test is narrow on purpose: a STRING is narrowed to the scalar
 * type the schema already asks for, and nothing else ever changes. Most of these
 * cases are therefore about what the helper must NOT do.
 */
describe("coerceCustomToolArgs", () => {
	describe("booleans", () => {
		const schema = z.object({ wake: z.boolean() })

		it.each([
			["true", true],
			["false", false],
			["TRUE", true],
			["  True  ", true],
			["FALSE", false],
		])("narrows %j to %j", (input, expected) => {
			expect(coerceCustomToolArgs(schema, { wake: input })).toEqual({ wake: expected })
		})

		it.each([["yes"], ["1"], ["0"], ["on"], [""], ["truthy"]])(
			"leaves %j alone — guessing it would be inventing an argument",
			(input) => {
				expect(coerceCustomToolArgs(schema, { wake: input })).toEqual({ wake: input })
			},
		)

		it("leaves a real boolean untouched", () => {
			const args = { wake: true }
			expect(coerceCustomToolArgs(schema, args)).toBe(args)
		})
	})

	describe("numbers", () => {
		const schema = z.object({ ttl_sec: z.number() })

		it.each([
			["300", 300],
			["  42 ", 42],
			["-7", -7],
			["3.5", 3.5],
			["0", 0],
			["1e3", 1000],
		])("narrows %j to %j", (input, expected) => {
			expect(coerceCustomToolArgs(schema, { ttl_sec: input })).toEqual({ ttl_sec: expected })
		})

		it.each([[""], ["   "], ["abc"], ["12abc"], ["Infinity"], ["NaN"]])(
			"leaves %j alone rather than fabricating a number",
			(input) => {
				expect(coerceCustomToolArgs(schema, { ttl_sec: input })).toEqual({ ttl_sec: input })
			},
		)

		it("leaves a real number untouched", () => {
			const args = { ttl_sec: 300 }
			expect(coerceCustomToolArgs(schema, args)).toBe(args)
		})
	})

	describe("wrapped schemas", () => {
		it.each([
			["optional", z.object({ wake: z.boolean().optional() })],
			["nullable", z.object({ wake: z.boolean().nullable() })],
			["default", z.object({ wake: z.boolean().default(false) })],
			["optional().nullable()", z.object({ wake: z.boolean().optional().nullable() })],
			["readonly", z.object({ wake: z.boolean().readonly() })],
		])("unwraps %s to find the boolean", (_label, schema) => {
			expect(coerceCustomToolArgs(schema, { wake: "true" })).toEqual({ wake: true })
		})

		it("unwraps a pipe to its INPUT side, which is what raw args are validated against", () => {
			const schema = z.object({ ttl_sec: z.number().transform((n) => n * 2) })
			expect(coerceCustomToolArgs(schema, { ttl_sec: "300" })).toEqual({ ttl_sec: 300 })
		})
	})

	describe("arrays of primitives", () => {
		it("coerces each element of a number array", () => {
			const schema = z.object({ ids: z.array(z.number()) })
			expect(coerceCustomToolArgs(schema, { ids: ["1", 2, "3"] })).toEqual({ ids: [1, 2, 3] })
		})

		it("coerces each element of a boolean array, through a wrapper", () => {
			const schema = z.object({ flags: z.array(z.boolean()).optional() })
			expect(coerceCustomToolArgs(schema, { flags: ["true", "false"] })).toEqual({ flags: [true, false] })
		})

		it("leaves a string array alone", () => {
			const schema = z.object({ names: z.array(z.string()) })
			const args = { names: ["true", "300"] }
			expect(coerceCustomToolArgs(schema, args)).toBe(args)
		})

		it("leaves an array of objects entirely alone", () => {
			const schema = z.object({ items: z.array(z.object({ n: z.number() })) })
			const args = { items: [{ n: "1" }] }
			expect(coerceCustomToolArgs(schema, args)).toBe(args)
		})
	})

	describe("what it must never touch", () => {
		it("leaves declared strings alone even when they look like scalars", () => {
			const schema = z.object({ label: z.string() })
			const args = { label: "true" }
			expect(coerceCustomToolArgs(schema, args)).toBe(args)
		})

		it("leaves an enum alone", () => {
			const schema = z.object({ kind: z.enum(["true", "false"]) })
			const args = { kind: "true" }
			expect(coerceCustomToolArgs(schema, args)).toBe(args)
		})

		it("leaves a nested object's contents alone — top-level keys only", () => {
			const schema = z.object({ opts: z.object({ wake: z.boolean() }) })
			const args = { opts: { wake: "true" } }
			expect(coerceCustomToolArgs(schema, args)).toBe(args)
		})

		it("passes through a key the schema does not declare", () => {
			const schema = z.object({ wake: z.boolean() })
			expect(coerceCustomToolArgs(schema, { wake: "true", extra: "300" })).toEqual({
				wake: true,
				extra: "300",
			})
		})

		it("never fills in a missing key", () => {
			const schema = z.object({ wake: z.boolean(), ttl_sec: z.number().optional() })
			expect(coerceCustomToolArgs(schema, { wake: "true" })).toEqual({ wake: true })
		})
	})

	describe("passthrough for anything it cannot introspect", () => {
		it("returns non-object args unchanged", () => {
			const schema = z.object({ wake: z.boolean() })
			expect(coerceCustomToolArgs(schema, "not an object")).toBe("not an object")
			expect(coerceCustomToolArgs(schema, null)).toBe(null)
			expect(coerceCustomToolArgs(schema, undefined)).toBe(undefined)
		})

		it("returns args unchanged for a non-object schema", () => {
			const args = { wake: "true" }
			expect(coerceCustomToolArgs(z.string(), args)).toBe(args)
			expect(coerceCustomToolArgs(z.array(z.number()), args)).toBe(args)
		})

		it("returns args unchanged for a schema it does not recognise at all", () => {
			const args = { wake: "true" }
			expect(coerceCustomToolArgs(undefined, args)).toBe(args)
			expect(coerceCustomToolArgs({}, args)).toBe(args)
			expect(coerceCustomToolArgs({ def: {} }, args)).toBe(args)
		})
	})

	describe("the reported failure, end to end through the schema", () => {
		// The live report: a stubbed `events_subscribe` called through the
		// `arguments_json` hatch, whose scalars the model quoted.
		const schema = z.object({
			selector: z.string(),
			wake: z.boolean().optional(),
			ttl_sec: z.number().optional(),
		})

		it("makes the stringified call validate", () => {
			const raw = { selector: "resource:vm-*", wake: "true", ttl_sec: "300" }
			expect(() => schema.parse(raw)).toThrow()
			expect(schema.parse(coerceCustomToolArgs(schema, raw))).toEqual({
				selector: "resource:vm-*",
				wake: true,
				ttl_sec: 300,
			})
		})

		it("still rejects a genuinely wrong value", () => {
			const raw = { selector: "resource:vm-*", wake: "maybe" }
			expect(() => schema.parse(coerceCustomToolArgs(schema, raw))).toThrow()
		})
	})
})
