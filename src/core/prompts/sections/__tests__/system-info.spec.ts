import os from "os"

// Mock the modules - must be hoisted before imports
vi.mock("os-name", () => ({
	default: vi.fn(),
}))

vi.mock("../../../utils/shell", () => ({
	getShell: vi.fn(() => "/bin/bash"),
}))

import { getSystemInfoSection } from "../system-info"
import osName from "os-name"
import { type SubmoduleEntry } from "../../../../utils/git-submodules"

const mockOsName = osName as unknown as ReturnType<typeof vi.fn>

describe("getSystemInfoSection", () => {
	const mockCwd = "/test/workspace"
	const mockHomeDir = "/home/user"

	beforeEach(() => {
		vi.spyOn(os, "homedir").mockReturnValue(mockHomeDir)
		vi.spyOn(os, "platform").mockReturnValue("linux" as any)
		vi.spyOn(os, "release").mockReturnValue("5.15.0")
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("should return system info with os-name when available", () => {
		mockOsName.mockReturnValue("Ubuntu 22.04")

		const result = getSystemInfoSection(mockCwd)

		expect(result).toContain("Operating System: Ubuntu 22.04")
		expect(result).toContain("Default Shell: /bin/bash")
		expect(result).toContain(`Home Directory: ${mockHomeDir}`)
		expect(result).toContain(`Current Workspace Directory: ${mockCwd}`)
	})

	it("should fallback to platform and release when os-name throws error", () => {
		mockOsName.mockImplementation(() => {
			throw new Error("Command failed with ENOENT: powershell")
		})

		const result = getSystemInfoSection(mockCwd)

		expect(result).toContain("Operating System: linux 5.15.0")
		expect(result).toContain("Default Shell: /bin/bash")
		expect(result).toContain(`Home Directory: ${mockHomeDir}`)
		expect(result).toContain(`Current Workspace Directory: ${mockCwd}`)
	})

	it("should handle Windows platform in fallback", () => {
		mockOsName.mockImplementation(() => {
			throw new Error("Command failed with ENOENT: powershell")
		})
		vi.spyOn(os, "platform").mockReturnValue("win32" as any)
		vi.spyOn(os, "release").mockReturnValue("10.0.19043")

		const result = getSystemInfoSection(mockCwd)

		expect(result).toContain("Operating System: win32 10.0.19043")
	})

	// --- Submodule block tests ---

	it("should not include submodule block when submoduleInfos is undefined", () => {
		mockOsName.mockReturnValue("Ubuntu 22.04")

		const result = getSystemInfoSection(mockCwd, undefined)

		expect(result).not.toContain("WORKSPACE SUBMODULES")
		expect(result).not.toContain("`code-server`")
	})

	it("should not include submodule block when submoduleInfos is empty", () => {
		mockOsName.mockReturnValue("Ubuntu 22.04")

		const result = getSystemInfoSection(mockCwd, [])

		expect(result).not.toContain("WORKSPACE SUBMODULES")
	})

	it("should include submodule block with a single entry", () => {
		mockOsName.mockReturnValue("Ubuntu 22.04")
		const entries: SubmoduleEntry[] = [{ path: "code-server", url: "https://github.com/coder/code-server.git" }]

		const result = getSystemInfoSection(mockCwd, entries)

		expect(result).toContain("====")
		expect(result).toContain("WORKSPACE SUBMODULES")
		expect(result).toContain("`code-server` → https://github.com/coder/code-server.git")
		expect(result).toContain("This workspace contains git submodules")
		expect(result).toContain("`cd` into that submodule's directory first")
	})

	it("should include submodule block with multiple entries including branches", () => {
		mockOsName.mockReturnValue("Ubuntu 22.04")
		const entries: SubmoduleEntry[] = [
			{ path: "code-server", url: "https://github.com/coder/code-server.git" },
			{ path: "extensions/shofer", url: "https://github.com/shofer-dev/shofer.git", branch: "master" },
		]

		const result = getSystemInfoSection(mockCwd, entries)

		expect(result).toContain("`code-server` → https://github.com/coder/code-server.git")
		expect(result).toContain("`extensions/shofer` → https://github.com/shofer-dev/shofer.git (branch: master)")
	})

	it("should still have all original system info when submodule block is present", () => {
		mockOsName.mockReturnValue("Ubuntu 22.04")
		const entries: SubmoduleEntry[] = [{ path: "code-server", url: "https://github.com/coder/code-server.git" }]

		const result = getSystemInfoSection(mockCwd, entries)

		expect(result).toContain("Operating System: Ubuntu 22.04")
		expect(result).toContain("Default Shell: /bin/bash")
		expect(result).toContain(`Home Directory: ${mockHomeDir}`)
		expect(result).toContain(`Current Workspace Directory: ${mockCwd}`)
		expect(result).toContain("WORKSPACE SUBMODULES")
	})
})
