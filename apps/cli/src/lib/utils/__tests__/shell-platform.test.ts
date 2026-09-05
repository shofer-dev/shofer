/**
 * Unit test for the Windows wording of `validateTerminalShellPath`
 * (`src/lib/utils/shell.ts`). The POSIX cases live in `shell.test.ts`; what is
 * added here is the branch that only runs when `process.platform` is `win32`,
 * where the executable-bit check is skipped and the refusal says so.
 */

import { validateTerminalShellPath } from "../shell.js"

describe("validateTerminalShellPath on win32", () => {
	let original: PropertyDescriptor

	beforeEach(() => {
		original = Object.getOwnPropertyDescriptor(process, "platform")!
		Object.defineProperty(process, "platform", { value: "win32", configurable: true })
	})

	afterEach(() => {
		Object.defineProperty(process, "platform", original)
	})

	it("omits the executable-bit wording from the refusal", async () => {
		// A POSIX-absolute path, because `path.isAbsolute` still answers for the
		// real host platform — only the branch inside the catch is being pinned.
		const result = await validateTerminalShellPath("/nonexistent-4f3a/cmd.exe")

		expect(result).toEqual({ valid: false, reason: "shell path does not exist or is not a file" })
	})

	it("still refuses a relative path before touching the filesystem", async () => {
		expect(await validateTerminalShellPath("cmd.exe")).toEqual({
			valid: false,
			reason: "shell path must be absolute",
		})
	})
})
