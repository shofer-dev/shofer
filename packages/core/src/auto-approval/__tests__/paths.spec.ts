import { isPathAutoApproved } from "../paths.js"

describe("isPathAutoApproved (outside-workspace path allowlist, design §4)", () => {
	const readPaths = ["/data/reference"]
	const writePaths = ["/workspace/generated"]

	it("approves a read under an allowedReadPaths entry", () => {
		expect(isPathAutoApproved("/data/reference/a.txt", "read", readPaths, writePaths)).toBe(true)
	})

	it("approves a read under an allowedWritePaths entry (write ⊇ read superset)", () => {
		expect(isPathAutoApproved("/workspace/generated/out.json", "read", readPaths, writePaths)).toBe(true)
	})

	it("approves a write under an allowedWritePaths entry", () => {
		expect(isPathAutoApproved("/workspace/generated/out.json", "write", readPaths, writePaths)).toBe(true)
	})

	it("does NOT approve a write under a read-only entry (read grant never enables writes)", () => {
		expect(isPathAutoApproved("/data/reference/a.txt", "write", readPaths, writePaths)).toBe(false)
	})

	it("matches the entry directory itself as well as its subtree", () => {
		expect(isPathAutoApproved("/data/reference", "read", readPaths, writePaths)).toBe(true)
		expect(isPathAutoApproved("/data/reference/nested/deep/x", "read", readPaths, writePaths)).toBe(true)
	})

	it("does NOT match a sibling that merely shares a name prefix (/foo vs /foobar)", () => {
		expect(isPathAutoApproved("/foobar/x", "read", ["/foo"], [])).toBe(false)
		expect(isPathAutoApproved("/foo-secrets/x", "read", ["/foo"], [])).toBe(false)
	})

	it("normalizes `..` traversal before matching (can't smuggle a path past a prefix)", () => {
		// Resolves to /etc/shadow, which is not under /data/reference.
		expect(isPathAutoApproved("/data/reference/../../etc/shadow", "read", readPaths, writePaths)).toBe(false)
		// Resolves back into the trusted subtree — approved.
		expect(isPathAutoApproved("/data/reference/sub/../a.txt", "read", readPaths, writePaths)).toBe(true)
	})

	it("returns false for an empty path", () => {
		expect(isPathAutoApproved("", "read", readPaths, writePaths)).toBe(false)
	})

	it("returns false when both allowlists are empty (feature inert by default)", () => {
		expect(isPathAutoApproved("/data/reference/a.txt", "read", [], [])).toBe(false)
		expect(isPathAutoApproved("/workspace/generated/out.json", "write", [], [])).toBe(false)
	})
})
