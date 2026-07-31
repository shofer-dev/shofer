// npx vitest src/core/config/__tests__/providersFileLoader.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import {
	PROVIDERS_FILE,
	deleteUserProvidersFile,
	fileSecretFields,
	loadMergedProvidersFile,
	writeUserProvidersFile,
} from "../providersFileLoader"

/**
 * Exercises the real loader against real temp directories (the same approach as
 * `ContextProxy.layered.spec`): `@shofer/core`'s disk reads are externalized in
 * this workspace's vitest, so an fs mock would not intercept them.
 */

let base: string
let roots: { global: string; user: string; project: string }

const put = async (root: string, doc: unknown) => {
	await fs.mkdir(root, { recursive: true })
	await fs.writeFile(path.join(root, PROVIDERS_FILE), JSON.stringify(doc))
}
const putLocked = async (locked: string[]) => {
	await fs.mkdir(roots.global, { recursive: true })
	await fs.writeFile(path.join(roots.global, "locked.json"), JSON.stringify({ version: 1, locked }))
}

describe("providersFileLoader", () => {
	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "providers-loader-"))
		roots = {
			global: path.join(base, "org", ".shofer"),
			user: path.join(base, "home", ".shofer"),
			project: path.join(base, "ws", ".shofer"),
		}
	})

	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true })
	})

	it("merges per profile name: project > user > org, adds pass through", async () => {
		await put(roots.global, { version: 1, profiles: { shared: { apiModelId: "org" }, orgOnly: { apiModelId: "o" } } })
		await put(roots.user, { version: 1, profiles: { shared: { apiModelId: "user" }, userOnly: { apiModelId: "u" } } })
		await put(roots.project, { version: 1, profiles: { shared: { apiModelId: "project" } } })

		const merged = await loadMergedProvidersFile(roots)

		expect(merged.profiles.shared).toEqual({ apiModelId: "project" })
		expect(merged.profiles.orgOnly).toEqual({ apiModelId: "o" })
		expect(merged.profiles.userOnly).toEqual({ apiModelId: "u" })
		expect(merged.originByName).toEqual({ shared: "project", orgOnly: "global", userOnly: "user" })
	})

	it("a locked profile keeps the org entry regardless of user/project overrides", async () => {
		await put(roots.global, { version: 1, profiles: { corp: { apiModelId: "org" } } })
		await put(roots.user, { version: 1, profiles: { corp: { apiModelId: "user" } } })
		await putLocked(["providers/corp"])

		const merged = await loadMergedProvidersFile(roots)

		expect(merged.profiles.corp).toEqual({ apiModelId: "org" })
		expect(merged.lockedNames.has("corp")).toBe(true)
	})

	it("`providers` locks the whole collection, but only for names the org defines", async () => {
		await put(roots.global, { version: 1, profiles: { corp: { apiModelId: "org" } } })
		await put(roots.user, { version: 1, profiles: { corp: { apiModelId: "user" }, mine: { apiModelId: "m" } } })
		await putLocked(["providers"])

		const merged = await loadMergedProvidersFile(roots)

		expect(merged.profiles.corp).toEqual({ apiModelId: "org" })
		// A name the org never defined is still the user's to add.
		expect(merged.profiles.mine).toEqual({ apiModelId: "m" })
	})

	it("currentApiConfigName follows more-specific-wins; modeApiConfigs deep-merge per mode", async () => {
		await put(roots.global, {
			version: 1,
			currentApiConfigName: "org",
			modeApiConfigs: { code: "o", debug: "o" },
			profiles: {},
		})
		await put(roots.user, { version: 1, currentApiConfigName: "user", modeApiConfigs: { code: "u" }, profiles: {} })
		await put(roots.project, { version: 1, modeApiConfigs: { architect: "p" }, profiles: {} })

		const merged = await loadMergedProvidersFile(roots)

		expect(merged.currentApiConfigName).toBe("user")
		expect(merged.modeApiConfigs).toEqual({ code: "u", debug: "o", architect: "p" })
	})

	it("a malformed or wrong-version scope file contributes an empty layer", async () => {
		await fs.mkdir(roots.user, { recursive: true })
		await fs.writeFile(path.join(roots.user, PROVIDERS_FILE), "{not json")
		await put(roots.global, { version: 999, profiles: { x: {} } })

		const merged = await loadMergedProvidersFile(roots)

		expect(merged.profiles).toEqual({})
	})

	it("fileSecretFields extracts only string-valued secret keys", () => {
		expect(
			fileSecretFields({ apiKey: "sk-x", apiModelId: "m", openRouterApiKey: 42 as unknown as string }),
		).toEqual({ apiKey: "sk-x" })
		expect(fileSecretFields(undefined)).toEqual({})
	})

	it("writeUserProvidersFile round-trips through loadMergedProvidersFile", async () => {
		await writeUserProvidersFile(roots.user, {
			version: 1,
			currentApiConfigName: "mine",
			modeApiConfigs: {},
			profiles: { mine: { apiProvider: "anthropic" } },
		})

		const merged = await loadMergedProvidersFile({ user: roots.user })
		expect(merged.profiles.mine).toEqual({ apiProvider: "anthropic" })
		expect(merged.currentApiConfigName).toBe("mine")

		await deleteUserProvidersFile(roots.user)
		const after = await loadMergedProvidersFile({ user: roots.user })
		expect(after.profiles).toEqual({})
	})
})
