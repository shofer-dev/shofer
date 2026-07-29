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
		mockFs.readdir = vi.fn(async (dir: any) => (dir === PLUGIN_DIR ? [dirent("deploy.md", PLUGIN_DIR)] : [])) as any
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

	it("getCommands lists a plugin command under its namespaced name", async () => {
		const commands = await getCommands("/test/cwd")
		const deploy = commands.find((c) => c.name === "my-plugin:deploy")
		expect(deploy).toBeDefined()
		// A bare name never resolves to a plugin command.
		expect(commands.find((c) => c.name === "deploy")).toBeUndefined()
		expect(deploy).toMatchObject({
			name: "my-plugin:deploy",
			source: "plugin",
			pluginName: "my-plugin",
			description: "Deploy the current project",
			argumentHint: "<environment>",
		})
	})

	it("getCommand resolves a plugin command by its namespaced name", async () => {
		const cmd = await getCommand("/test/cwd", "my-plugin:deploy")
		expect(cmd).toMatchObject({ name: "my-plugin:deploy", source: "plugin", pluginName: "my-plugin" })
		expect(cmd?.content).toBe("Deploy body")
	})

	it("getCommand does NOT resolve a plugin command by its bare name", async () => {
		const cmd = await getCommand("/test/cwd", "deploy")
		expect(cmd).toBeUndefined()
	})

	it("contributes nothing when no plugin manager is wired", async () => {
		setSharedPluginManager(undefined)
		const commands = await getCommands("/test/cwd")
		expect(commands).toHaveLength(0)
	})

	describe("the bundled-plugin exemption (`unqualifiedContributions`)", () => {
		// A first-party plugin shipping the platform's own commands keeps their authored
		// names — `/merge-worktree` must not become `/worktrees:merge-worktree` just
		// because the worktree feature moved out of core into the `basics` plugin.
		beforeEach(() => {
			setSharedPluginManager({
				getContributedCommandDirs: () => [{ pluginName: "my-plugin", dir: PLUGIN_DIR, unqualified: true }],
			} as any)
		})

		it("lists and resolves the command under its authored name", async () => {
			const commands = await getCommands("/test/cwd")
			expect(commands.find((c) => c.name === "my-plugin:deploy")).toBeUndefined()
			expect(commands.find((c) => c.name === "deploy")).toMatchObject({
				name: "deploy",
				source: "plugin",
				pluginName: "my-plugin",
			})

			const cmd = await getCommand("/test/cwd", "deploy")
			expect(cmd).toMatchObject({ name: "deploy", source: "plugin", pluginName: "my-plugin" })
			expect(cmd?.content).toBe("Deploy body")
		})

		it("sits at the built-in tier, so a project file of the same name still wins", async () => {
			const projectDir = path.join("/test/cwd", ".shofer", "commands")
			const projectMd = path.join(projectDir, "deploy.md")
			mockFs.readdir = vi.fn(async (dir: any) => {
				if (dir === PLUGIN_DIR) return [dirent("deploy.md", PLUGIN_DIR)]
				if (dir === projectDir) return [dirent("deploy.md", projectDir)]
				return []
			}) as any
			mockFs.readFile = vi.fn(async (file: any) => {
				if (file === DEPLOY_MD) return "Deploy body"
				if (file === projectMd) return "Project body"
				throw new Error("File not found")
			}) as any

			const deploy = (await getCommands("/test/cwd")).find((c) => c.name === "deploy")
			expect(deploy).toMatchObject({ name: "deploy", source: "project" })
			expect(deploy?.content).toBe("Project body")

			// …and the direct lookup agrees: project is checked before the plugin.
			expect(await getCommand("/test/cwd", "deploy")).toMatchObject({ source: "project" })
		})
	})

	it("hides a private command from getCommands but keeps it resolvable via getCommand", async () => {
		setSharedPluginManager({
			getContributedCommandDirs: () => [{ pluginName: "my-plugin", dir: PLUGIN_DIR, privateNames: ["deploy"] }],
		} as any)

		// Enumeration excludes the private command entirely.
		const commands = await getCommands("/test/cwd")
		expect(commands.find((c) => c.name === "my-plugin:deploy")).toBeUndefined()

		// But it is still invocable by its qualified name.
		const cmd = await getCommand("/test/cwd", "my-plugin:deploy")
		expect(cmd).toMatchObject({ name: "my-plugin:deploy", source: "plugin", pluginName: "my-plugin" })
		expect(cmd?.content).toBe("Deploy body")
	})
})

describe("Plugin command namespacing — no cross-plugin conflict (design §14.7)", () => {
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

	it("both plugins' same-authored command coexist under distinct namespaced names, no warning", async () => {
		const commands = await getCommands("/test/cwd")
		const a = commands.find((c) => c.name === "a:deploy")
		const b = commands.find((c) => c.name === "b:deploy")
		expect(a).toMatchObject({ name: "a:deploy", pluginName: "a", content: "from-A" })
		expect(b).toMatchObject({ name: "b:deploy", pluginName: "b", content: "from-B" })

		const warns = notifier.messages.filter((m) => m.level === "warn").map((m) => m.message)
		expect(warns.some((m) => m.includes("shadows"))).toBe(false)
	})

	it("getCommand resolves each plugin's command by its own namespaced name", async () => {
		expect(await getCommand("/test/cwd", "a:deploy")).toMatchObject({ pluginName: "a", content: "from-A" })
		expect(await getCommand("/test/cwd", "b:deploy")).toMatchObject({ pluginName: "b", content: "from-B" })
	})
})
