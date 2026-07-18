import { normalizeMoonshotToolSchema } from "../moonshot-schema.js"

describe("normalizeMoonshotToolSchema", () => {
	it("drops JSON null entries from an enum (the case Kimi 400s on)", () => {
		const out = normalizeMoonshotToolSchema({
			type: "object",
			properties: { mode: { type: "string", enum: ["code", "ask", null] } },
		})
		expect(out.properties.mode.enum).toEqual(["code", "ask"])
	})

	it("collapses a nullable union type to the non-null primitive", () => {
		const out = normalizeMoonshotToolSchema({
			type: "object",
			properties: { p: { type: ["string", "null"] } },
		})
		expect(out.properties.p.type).toBe("string")
	})

	it("drops a type that is only 'null'", () => {
		const out = normalizeMoonshotToolSchema({ type: "object", properties: { p: { type: "null" } } })
		expect("type" in out.properties.p).toBe(false)
	})

	it("collapses a nullable anyOf into the surviving branch", () => {
		const out = normalizeMoonshotToolSchema({
			type: "object",
			properties: { p: { anyOf: [{ type: "string" }, { type: "null" }] } },
		})
		// the {type:"null"} branch normalizes to {} and is dropped; the lone
		// survivor collapses into the parent.
		expect(out.properties.p.type).toBe("string")
		expect("anyOf" in out.properties.p).toBe(false)
	})

	it("recurses through items and $defs", () => {
		const out = normalizeMoonshotToolSchema({
			type: "object",
			properties: { list: { type: "array", items: { type: "string", enum: ["a", null] } } },
			$defs: { d: { type: ["number", "null"] } },
		})
		expect(out.properties.list.items.enum).toEqual(["a"])
		expect(out.$defs.d.type).toBe("number")
	})

	it("does not mutate the input schema", () => {
		const input = { type: "object", properties: { m: { type: "string", enum: ["x", null] } } }
		normalizeMoonshotToolSchema(input)
		expect(input.properties.m.enum).toEqual(["x", null])
	})
})
