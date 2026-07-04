import fs from "fs/promises"
import * as path from "path"
import { createInMemoryHost, setHost } from "@shofer/types"

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
		mockFs.readdir = vi.fn(async (dir: any) =>
			dir === PLUGIN_DIR ? [dirent("deploy.md", PLUGIN_DIR)] : [],
		) as any
		mockFs.readFile = vi.fn(async (file: any) => {
			if (file === DEPLOY_MD) {
				return `---\ndescription: Deploy the current project\nargument-hint: <environment>\n---\nDeploy body`
			}
			throw new Error("File not found")
		}) as any
		setSharedPluginManager({
			getContributedCommandDirs: () => [{ pluginName: "my-plugin", dir: PLUGIN_DIR }],
		} as any)
	})

	afterEach(() => {
		setSharedPluginManager(undefined)
	})

	it("getCommands lists a plugin command with its natural (non-namespaced) name", async () => {
		const commands = await getCommands("/test/cwd")
		const deploy = commands.find((c) => c.name === "deploy")
		expect(deploy).toBeDefined()
		expect(deploy).toMatchObject({
			name: "deploy",
			source: "plugin",
			pluginName: "my-plugin",
			description: "Deploy the current project",
			argumentHint: "<environment>",
		})
	})

	it("getCommand resolves a plugin command by its natural name", async () => {
		const cmd = await getCommand("/test/cwd", "deploy")
		expect(cmd).toMatchObject({ name: "deploy", source: "plugin", pluginName: "my-plugin" })
		expect(cmd?.content).toBe("Deploy body")
	})

	it("contributes nothing when no plugin manager is wired", async () => {
		setSharedPluginManager(undefined)
		const commands = await getCommands("/test/cwd")
		expect(commands).toHaveLength(0)
	})
})

describe("Plugin command conflicts — last-installed-wins + warning (design §14.7)", () => {
	const DIR_A = path.join("/plugins", "a", "commands")
	const DIR_B = path.join("/plugins", "b", "commands")
	const A_MD = path.join(DIR_A, "deploy.md")
	const B_MD = path.join(DIR_B, "deploy.md")
	const mockFs = vi.mocked(fs)
	let notifier: { messages: Array<{ level: string; message: string }> }

	const dirent = (name: string, parentPath: string) =>
		({ name, parentPath, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }) as any

	beforeEach(() => {
		vi.clearAllMocks()
		const host = createInMemoryHost()
		notifier = host.notifier as any
		setHost(host)
		mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
		mockFs.readdir = vi.fn(async (dir: any) => {
			if (dir === DIR_A) return [dirent("deploy.md", DIR_A)]
			if (dir === DIR_B) return [dirent("deploy.md", DIR_B)]
			return []
		}) as any
		mockFs.readFile = vi.fn(async (file: any) => {
			if (file === A_MD) return "from-A"
			if (file === B_MD) return "from-B"
			throw new Error("File not found")
		}) as any
		// getContributedCommandDirs returns install-rank ascending: a then b ⇒ b last.
		setSharedPluginManager({
			getContributedCommandDirs: () => [
				{ pluginName: "a", dir: DIR_A },
				{ pluginName: "b", dir: DIR_B },
			],
		} as any)
	})

	afterEach(() => {
		setSharedPluginManager(undefined)
	})

	it("last-installed plugin wins the natural name, warns naming both plugins", async () => {
		const commands = await getCommands("/test/cwd")
		const deploy = commands.filter((c) => c.name === "deploy")
		expect(deploy).toHaveLength(1)
		expect(deploy[0]).toMatchObject({ name: "deploy", pluginName: "b", content: "from-B" })

		const warns = notifier.messages.filter((m) => m.level === "warn").map((m) => m.message)
		expect(warns.some((m) => m.includes("deploy") && m.includes('"b"') && m.includes('"a"'))).toBe(true)
	})

	it("getCommand returns the last-installed plugin's command", async () => {
		const cmd = await getCommand("/test/cwd", "deploy")
		expect(cmd).toMatchObject({ name: "deploy", pluginName: "b", content: "from-B" })
	})
})
