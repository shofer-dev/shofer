import fs from "fs/promises"
import * as path from "path"

import { getCommand, getCommands } from "../commands.js"
import { setSharedPluginManager } from "../../../plugins/plugin-manager.js"

vi.mock("fs/promises")
vi.mock("../built-in-commands.js", () => ({
	getBuiltInCommands: vi.fn(() => Promise.resolve([])),
	getBuiltInCommand: vi.fn(() => Promise.resolve(undefined)),
	getBuiltInCommandNames: vi.fn(() => Promise.resolve([])),
}))

const mockFs = vi.mocked(fs)
const PLUGIN_DIR = path.join("/plugins", "my-plugin", "commands")
const DEPLOY_MD = path.join(PLUGIN_DIR, "deploy.md")

const dirent = (name: string, parentPath: string) =>
	({
		name,
		parentPath,
		isFile: () => true,
		isDirectory: () => false,
		isSymbolicLink: () => false,
	}) as any

describe("Plugin-contributed slash commands (Phase 1)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
		mockFs.readdir = vi.fn(async (dir: any) => (dir === PLUGIN_DIR ? [dirent("deploy.md", PLUGIN_DIR)] : []))
		mockFs.readFile = vi.fn(async (file: any) => {
			if (file === DEPLOY_MD) {
				return `---\ndescription: Deploy the current project\nargument-hint: <environment>\n---\nDeploy body`
			}
			throw new Error("File not found")
		})
		setSharedPluginManager({
			getContributedCommandDirs: () => [{ pluginName: "my-plugin", dir: PLUGIN_DIR }],
		} as any)
	})

	afterEach(() => {
		setSharedPluginManager(undefined)
	})

	it("getCommands lists a plugin command with a namespaced name", async () => {
		const commands = await getCommands("/test/cwd")
		const deploy = commands.find((c) => c.name === "my-plugin:deploy")
		expect(deploy).toBeDefined()
		expect(deploy).toMatchObject({
			name: "my-plugin:deploy",
			source: "plugin",
			pluginName: "my-plugin",
			description: "Deploy the current project",
			argumentHint: "<environment>",
		})
	})

	it("getCommand resolves a namespaced plugin command", async () => {
		const cmd = await getCommand("/test/cwd", "my-plugin:deploy")
		expect(cmd).toMatchObject({ name: "my-plugin:deploy", source: "plugin", pluginName: "my-plugin" })
		expect(cmd?.content).toBe("Deploy body")
	})

	it("contributes nothing when no plugin manager is wired", async () => {
		setSharedPluginManager(undefined)
		const commands = await getCommands("/test/cwd")
		expect(commands).toHaveLength(0)
	})
})
