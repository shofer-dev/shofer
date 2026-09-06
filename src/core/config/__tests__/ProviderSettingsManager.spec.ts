// npx vitest src/core/config/__tests__/ProviderSettingsManager.spec.ts

import { ExtensionContext } from "vscode"

import { PROFILE_SECRET_KEYS } from "@shofer/types"

import { ProviderSettingsManager } from "../ProviderSettingsManager"
import type { MergedProvidersFile, ProvidersFile } from "../providersFileLoader"

/**
 * The manager's two persistence halves are mocked in memory:
 *   - the SecretStorage blob via `mockSecrets` (real `context.secrets` shape);
 *   - the layered providers file via a mocked `providersFileLoader`, with one
 *     in-memory doc per scope and a merge emulation mirroring the real
 *     per-name project > user > org rule (locks included).
 *
 * Assertions go through the public API plus the two split artifacts (the user
 * doc the writer received, and the v2 blob written to secrets) — never through
 * a private storage format.
 */

const emptyDoc = (): ProvidersFile => ({ version: 1, profiles: {} })

const hoisted = vi.hoisted(() => ({
	files: {
		org: { version: 1, profiles: {} } as any,
		user: { version: 1, profiles: {} } as any,
		project: { version: 1, profiles: {} } as any,
	},
	locked: new Set<string>(),
}))

vi.mock("../providersFileLoader", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../providersFileLoader")>()
	return {
		...actual,
		resolveProviderScopeRoots: vi.fn(() => ({
			global: "/mock/org/.shofer",
			user: "/mock/home/.shofer",
			project: undefined,
		})),
		loadMergedProvidersFile: vi.fn(async (): Promise<MergedProvidersFile> => {
			const { org, user, project } = hoisted.files
			const profiles: Record<string, Record<string, unknown>> = {}
			const originByName: Record<string, "global" | "user" | "project"> = {}
			const lockedNames = new Set<string>()
			const wholeLocked = hoisted.locked.has("providers")
			for (const [origin, doc] of [
				["global", org],
				["user", user],
				["project", project],
			] as const) {
				for (const [name, body] of Object.entries(doc.profiles) as [string, Record<string, unknown>][]) {
					const locked = name in org.profiles && (wholeLocked || hoisted.locked.has(`providers/${name}`))
					if (locked) {
						lockedNames.add(name)
						if (origin !== "global") continue
					}
					profiles[name] = body
					originByName[name] = origin
				}
			}
			return {
				currentApiConfigName:
					project.currentApiConfigName ?? user.currentApiConfigName ?? org.currentApiConfigName,
				modeApiConfigs: {
					...(org.modeApiConfigs ?? {}),
					...(user.modeApiConfigs ?? {}),
					...(project.modeApiConfigs ?? {}),
				},
				profiles,
				originByName,
				lockedNames,
			}
		}),
		writeUserProvidersFile: vi.fn(async (_root: string, doc: ProvidersFile) => {
			hoisted.files.user = doc
		}),
		deleteUserProvidersFile: vi.fn(async () => {
			hoisted.files.user = { version: 1, profiles: {} }
		}),
	}
})

// Mock VSCode ExtensionContext
const mockSecrets = {
	get: vi.fn(),
	store: vi.fn(),
	delete: vi.fn(),
}

const mockGlobalState = {
	get: vi.fn(),
	update: vi.fn(),
}

const mockContext = {
	secrets: mockSecrets,
	globalState: mockGlobalState,
} as unknown as ExtensionContext

/** The last v2 blob written to SecretStorage (parsed), or undefined. */
const lastBlob = () => {
	const calls = mockSecrets.store.mock.calls
	return calls.length ? JSON.parse(calls[calls.length - 1][1]) : undefined
}

/** In-memory secrets round-trip: what store() wrote is what get() returns. */
const wireSecretsRoundTrip = () => {
	let stored: string | undefined
	mockSecrets.get.mockImplementation(async () => stored)
	mockSecrets.store.mockImplementation(async (_key: string, value: string) => {
		stored = value
	})
	return { seed: (value: string) => (stored = value) }
}

describe("ProviderSettingsManager", () => {
	let providerSettingsManager: ProviderSettingsManager

	beforeEach(() => {
		vi.clearAllMocks()
		hoisted.files.org = emptyDoc()
		hoisted.files.user = emptyDoc()
		hoisted.files.project = emptyDoc()
		hoisted.locked.clear()
		mockSecrets.get.mockResolvedValue(null)
		mockSecrets.store.mockResolvedValue(undefined)
		mockSecrets.delete.mockResolvedValue(undefined)
		mockGlobalState.get.mockReturnValue(undefined)
		mockGlobalState.update.mockResolvedValue(undefined)

		providerSettingsManager = new ProviderSettingsManager(mockContext)
	})

	describe("initialize", () => {
		it("writes nothing on a fresh install (defaults are implicit)", async () => {
			await providerSettingsManager.initialize()

			expect(mockSecrets.store).not.toHaveBeenCalled()
			expect(hoisted.files.user.profiles).toEqual({})
		})

		it("splits a legacy full-profiles blob into providers.json + v2 secrets blob", async () => {
			const { seed } = wireSecretsRoundTrip()
			seed(
				JSON.stringify({
					currentApiConfigName: "work",
					apiConfigs: {
						work: { id: "work-id", apiProvider: "anthropic", apiKey: "sk-legacy", apiModelId: "claude-3" },
					},
					modeApiConfigs: { code: "work-id" },
					migrations: {
						rateLimitSecondsMigrated: true,
						openAiHeadersMigrated: true,
						consecutiveMistakeLimitMigrated: true,
						todoListEnabledMigrated: true,
						claudeCodeLegacySettingsMigrated: true,
					},
				}),
			)

			await providerSettingsManager.initialize()

			// Non-secret fields land in the user providers file, key stays out.
			const fileProfile = hoisted.files.user.profiles.work
			expect(fileProfile).toMatchObject({ id: "work-id", apiProvider: "anthropic", apiModelId: "claude-3" })
			expect(fileProfile.apiKey).toBeUndefined()
			expect(hoisted.files.user.currentApiConfigName).toBe("work")
			expect(hoisted.files.user.modeApiConfigs).toEqual({ code: "work-id" })

			// The blob is v2 and carries only the secret.
			const blob = lastBlob()
			expect(blob.version).toBe(2)
			expect(blob.secrets.work).toEqual({ apiKey: "sk-legacy" })
			expect(blob.apiConfigs).toBeUndefined()

			// The composed view still returns the full profile.
			const profile = await providerSettingsManager.getProfile({ name: "work" })
			expect(profile.apiKey).toBe("sk-legacy")
		})

		it("generates IDs for file profiles that lack them", async () => {
			wireSecretsRoundTrip()
			hoisted.files.user.profiles = { noid: { apiProvider: "anthropic" } }

			await providerSettingsManager.initialize()

			expect(hoisted.files.user.profiles.noid.id).toBeTruthy()
		})

		it("derives a stable id for an org-layer profile it cannot write back", async () => {
			// The org mount is read-only, so the initialize() backfill above never
			// reaches an org-only profile — yet the UI keys on ids (a ModesView
			// SelectItem with value="" crashes React) and per-mode associations
			// reference them. load() must therefore synthesize one, and it must
			// be the NAME so every workspace derives the same id.
			wireSecretsRoundTrip()
			hoisted.files.org.profiles = { "llm-router": { apiProvider: "shofer" } }

			const configs = await providerSettingsManager.listConfig()

			const org = configs.find((c) => c.name === "llm-router")
			expect(org?.id).toBe("llm-router")
			// and nothing was copied into the user file to achieve it
			expect(hoisted.files.user.profiles["llm-router"]).toBeUndefined()
		})

		it("strips removed claude-code CLI keys via the legacy migration", async () => {
			const { seed } = wireSecretsRoundTrip()
			seed(
				JSON.stringify({
					currentApiConfigName: "cc",
					apiConfigs: {
						cc: { id: "cc-id", apiProvider: "claude-code", claudeCodePath: "/usr/bin/claude" },
					},
					migrations: {
						rateLimitSecondsMigrated: true,
						openAiHeadersMigrated: true,
						consecutiveMistakeLimitMigrated: true,
						todoListEnabledMigrated: true,
						claudeCodeLegacySettingsMigrated: false,
					},
				}),
			)

			await providerSettingsManager.initialize()

			expect(hoisted.files.user.profiles.cc?.claudeCodePath).toBeUndefined()
			expect(lastBlob().migrations.claudeCodeLegacySettingsMigrated).toBe(true)
		})
	})

	describe("SaveConfig", () => {
		it("splits a saved profile: non-secret fields to the file, the key to the blob", async () => {
			wireSecretsRoundTrip()

			const id = await providerSettingsManager.saveConfig("test", {
				apiProvider: "anthropic",
				apiKey: "sk-test",
				apiModelId: "claude-3-opus-20240229",
			})

			const fileProfile = hoisted.files.user.profiles.test
			expect(fileProfile).toMatchObject({
				id,
				apiProvider: "anthropic",
				apiModelId: "claude-3-opus-20240229",
			})
			for (const key of PROFILE_SECRET_KEYS) {
				expect(fileProfile[key]).toBeUndefined()
			}
			expect(lastBlob().secrets.test).toEqual({ apiKey: "sk-test" })
		})

		it("preserves the existing ID on update", async () => {
			wireSecretsRoundTrip()
			hoisted.files.user.profiles = { keep: { id: "keep-id", apiProvider: "anthropic" } }

			const id = await providerSettingsManager.saveConfig("keep", {
				apiProvider: "anthropic",
				apiModelId: "claude-3",
			})

			expect(id).toBe("keep-id")
			expect(hoisted.files.user.profiles.keep.id).toBe("keep-id")
		})

		it("filters out other providers' fields via the discriminated schema", async () => {
			wireSecretsRoundTrip()

			await providerSettingsManager.saveConfig("clean", {
				apiProvider: "anthropic",
				apiModelId: "claude-3",
				// An openai-only field must not survive on an anthropic profile.
				openAiBaseUrl: "https://example.com/v1",
			} as any)

			expect(hoisted.files.user.profiles.clean.openAiBaseUrl).toBeUndefined()
		})

		it("keeps a retired provider's legacy fields via passthrough", async () => {
			wireSecretsRoundTrip()

			await providerSettingsManager.saveConfig("legacy", {
				apiProvider: "groq",
				groqApiKey: "legacy-groq-key",
				apiModelId: "legacy-model",
			} as any)

			expect(hoisted.files.user.profiles.legacy.groqApiKey).toBe("legacy-groq-key")
		})
	})

	describe("composition (file + blob)", () => {
		it("uses an org-supplied file key as the default credential", async () => {
			wireSecretsRoundTrip()
			hoisted.files.org.profiles = {
				corp: { id: "corp-id", apiProvider: "anthropic", apiKey: "sk-org-default" },
			}

			const profile = await providerSettingsManager.getProfile({ name: "corp" })
			expect(profile.apiKey).toBe("sk-org-default")
		})

		it("lets a locally-entered key win over the org-supplied one", async () => {
			wireSecretsRoundTrip()
			hoisted.files.org.profiles = {
				corp: { id: "corp-id", apiProvider: "anthropic", apiKey: "sk-org-default" },
			}

			await providerSettingsManager.saveConfig("corp", {
				id: "corp-id",
				apiProvider: "anthropic",
				apiKey: "sk-my-own",
			})

			const profile = await providerSettingsManager.getProfile({ name: "corp" })
			expect(profile.apiKey).toBe("sk-my-own")
			expect(lastBlob().secrets.corp).toEqual({ apiKey: "sk-my-own" })
		})

		it("does not copy a file-sourced key into the blob when unchanged", async () => {
			wireSecretsRoundTrip()
			hoisted.files.org.profiles = {
				corp: { id: "corp-id", apiProvider: "anthropic", apiKey: "sk-org-default" },
			}

			// A save that keeps the org key as-is (e.g. edits only the model).
			await providerSettingsManager.saveConfig("corp", {
				id: "corp-id",
				apiProvider: "anthropic",
				apiKey: "sk-org-default",
				apiModelId: "claude-3",
			})

			// The key stays file-sourced so an org rotation takes effect.
			expect(lastBlob().secrets.corp).toBeUndefined()
		})

		it("sanitizes an unknown provider (kept, apiProvider reset)", async () => {
			wireSecretsRoundTrip()
			hoisted.files.user.profiles = {
				removed: { id: "removed-id", apiProvider: "invalid-removed-provider", apiModelId: "m" },
			}

			const list = await providerSettingsManager.listConfig()
			const entry = list.find((e) => e.id === "removed-id")
			expect(entry).toBeDefined()
			expect(entry!.apiProvider).toBeUndefined()
		})

		it("drops a non-object profile body entirely", async () => {
			wireSecretsRoundTrip()
			hoisted.files.user.profiles = {
				valid: { id: "v", apiProvider: "anthropic" },
				broken: "not an object" as any,
			}

			const list = await providerSettingsManager.listConfig()
			expect(list.map((e) => e.name).sort()).toEqual(["valid"])
		})

		it("falls back to an existing profile when currentApiConfigName is dangling", async () => {
			wireSecretsRoundTrip()
			hoisted.files.user = {
				version: 1,
				currentApiConfigName: "gone",
				profiles: { only: { id: "only-id", apiProvider: "anthropic" } },
			}

			const profile = await providerSettingsManager.activateProfile({ name: "only" })
			expect(profile.name).toBe("only")
		})
	})

	describe("scope discipline in store()", () => {
		it("does not copy an unchanged org profile into the user file", async () => {
			wireSecretsRoundTrip()
			hoisted.files.org.profiles = { corp: { id: "corp-id", apiProvider: "anthropic" } }

			// Any store-triggering operation on an unrelated profile.
			await providerSettingsManager.saveConfig("mine", { apiProvider: "anthropic" })

			expect(hoisted.files.user.profiles.corp).toBeUndefined()
			expect(hoisted.files.user.profiles.mine).toBeDefined()
		})

		it("persists a user edit of an unlocked org profile as a user-scope override", async () => {
			wireSecretsRoundTrip()
			hoisted.files.org.profiles = { corp: { id: "corp-id", apiProvider: "anthropic" } }

			await providerSettingsManager.saveConfig("corp", {
				id: "corp-id",
				apiProvider: "anthropic",
				apiModelId: "claude-3-opus-20240229",
			})

			expect(hoisted.files.user.profiles.corp.apiModelId).toBe("claude-3-opus-20240229")
		})

		it("never persists a locked profile into the user file", async () => {
			wireSecretsRoundTrip()
			hoisted.files.org.profiles = { corp: { id: "corp-id", apiProvider: "anthropic" } }
			hoisted.locked.add("providers/corp")

			await providerSettingsManager.saveConfig("corp", {
				id: "corp-id",
				apiProvider: "anthropic",
				apiModelId: "something-else",
			})

			expect(hoisted.files.user.profiles.corp).toBeUndefined()
			// The org entry stays the effective one.
			const profile = await providerSettingsManager.getProfile({ name: "corp" })
			expect(profile.apiModelId).toBeUndefined()
		})
	})

	describe("activateProfile / mode configs", () => {
		it("persists the active profile name in the user file", async () => {
			wireSecretsRoundTrip()
			hoisted.files.user.profiles = { test: { id: "test-id", apiProvider: "anthropic" } }

			const { name } = await providerSettingsManager.activateProfile({ name: "test" })

			expect(name).toBe("test")
			expect(hoisted.files.user.currentApiConfigName).toBe("test")
		})

		it("throws when the profile does not exist", async () => {
			wireSecretsRoundTrip()
			hoisted.files.user.profiles = { default: { id: "d" } }

			await expect(providerSettingsManager.activateProfile({ name: "nonexistent" })).rejects.toThrow(
				"Config with name 'nonexistent' not found",
			)
		})

		it("persists mode → profile-id associations in the user file", async () => {
			wireSecretsRoundTrip()
			hoisted.files.user.profiles = { test: { id: "test-id", apiProvider: "anthropic" } }

			await providerSettingsManager.setModeConfig("code" as any, "test-id")

			expect(hoisted.files.user.modeApiConfigs).toEqual({ code: "test-id" })
			expect(await providerSettingsManager.getModeConfigId("code" as any)).toBe("test-id")
			expect(await providerSettingsManager.getModeConfigs()).toEqual({ code: "test-id" })
		})
	})

	describe("DeleteConfig", () => {
		it("removes the profile from the user file and its secrets from the blob", async () => {
			wireSecretsRoundTrip()
			hoisted.files.user.profiles = {
				keep: { id: "k", apiProvider: "anthropic" },
				drop: { id: "d", apiProvider: "anthropic" },
			}
			await providerSettingsManager.saveConfig("drop", { id: "d", apiProvider: "anthropic", apiKey: "sk-d" })

			await providerSettingsManager.deleteConfig("drop")

			expect(hoisted.files.user.profiles.drop).toBeUndefined()
			expect(lastBlob().secrets.drop).toBeUndefined()
			expect(await providerSettingsManager.hasConfig("drop")).toBe(false)
			expect(await providerSettingsManager.hasConfig("keep")).toBe(true)
		})

		it("refuses to delete the last remaining profile", async () => {
			wireSecretsRoundTrip()
			hoisted.files.user.profiles = { only: { id: "o", apiProvider: "anthropic" } }

			await expect(providerSettingsManager.deleteConfig("only")).rejects.toThrow(
				"Cannot delete the last remaining configuration",
			)
		})

		it("throws when the profile does not exist", async () => {
			wireSecretsRoundTrip()
			hoisted.files.user.profiles = { a: { id: "a" }, b: { id: "b" } }

			await expect(providerSettingsManager.deleteConfig("missing")).rejects.toThrow("Config 'missing' not found")
		})
	})

	describe("ListConfig", () => {
		it("lists the composed profiles across scopes", async () => {
			wireSecretsRoundTrip()
			hoisted.files.org.profiles = { corp: { id: "corp-id", apiProvider: "anthropic" } }
			hoisted.files.user.profiles = { mine: { id: "mine-id", apiProvider: "openai", openAiModelId: "gpt-5" } }

			const list = await providerSettingsManager.listConfig()

			expect(list.map((e) => e.name).sort()).toEqual(["corp", "mine"])
			expect(list.find((e) => e.name === "mine")!.modelId).toBe("gpt-5")
		})
	})

	describe("Export", () => {
		it("exports composed profiles including blob-held secrets", async () => {
			wireSecretsRoundTrip()
			await providerSettingsManager.saveConfig("test", {
				apiProvider: "anthropic",
				apiKey: "sk-test",
				apiModelId: "claude-3-opus-20240229",
			})

			const exported = await providerSettingsManager.export()

			expect(exported.apiConfigs.test.apiKey).toBe("sk-test")
			expect(exported.apiConfigs.test.apiModelId).toBe("claude-3-opus-20240229")
		})
	})

	describe("ResetAllConfigs", () => {
		it("deletes the secrets blob and the user providers file", async () => {
			wireSecretsRoundTrip()
			hoisted.files.user.profiles = { test: { id: "t", apiProvider: "anthropic" } }

			await providerSettingsManager.resetAllConfigs()

			expect(mockSecrets.delete).toHaveBeenCalledWith("shofer_config_api_config")
			expect(hoisted.files.user.profiles).toEqual({})
		})
	})
})

/**
 * The MIGRATION pass and the surfaces around it. Every migration is wrapped so a
 * failure leaves the old value in place and logs — a throw here would abort
 * `initialize()` and leave the extension with no provider profiles at all — and
 * every public method wraps its own failure into a named error, because a bare
 * rejection out of the lock reads to the caller as "the settings are gone".
 */
describe("ProviderSettingsManager migrations and refusals", () => {
	let manager: ProviderSettingsManager

	/** A legacy blob with no `migrations` field, so every migration runs. */
	function unmigratedBlob(apiConfigs: Record<string, Record<string, unknown>>) {
		return JSON.stringify({ currentApiConfigName: Object.keys(apiConfigs)[0], apiConfigs })
	}

	beforeEach(() => {
		vi.clearAllMocks()
		hoisted.files.org = emptyDoc()
		hoisted.files.user = emptyDoc()
		hoisted.files.project = emptyDoc()
		hoisted.locked.clear()
		mockSecrets.get.mockResolvedValue(null)
		mockSecrets.store.mockResolvedValue(undefined)
		mockSecrets.delete.mockResolvedValue(undefined)
		mockGlobalState.get.mockReturnValue(undefined)
		mockGlobalState.update.mockResolvedValue(undefined)
		manager = new ProviderSettingsManager(mockContext)
	})

	it("seeds the rate limit from the retired global-state value", async () => {
		const { seed } = wireSecretsRoundTrip()
		seed(unmigratedBlob({ work: { id: "w", apiProvider: "anthropic" } }))
		mockGlobalState.get.mockReturnValue(12)

		await manager.initialize()

		expect(hoisted.files.user.profiles.work.rateLimitSeconds).toBe(12)
	})

	it("falls back to ZERO when the retired value cannot be read", async () => {
		const { seed } = wireSecretsRoundTrip()
		seed(unmigratedBlob({ work: { id: "w", apiProvider: "anthropic" } }))
		mockGlobalState.get.mockImplementation(() => {
			throw new Error("state store gone")
		})

		await manager.initialize()

		// A failed read must not leave the field undefined — that would be read
		// downstream as "no limit configured" and re-migrated on every start.
		expect(hoisted.files.user.profiles.work.rateLimitSeconds).toBe(0)
	})

	it("does not overwrite a rate limit the profile already carries", async () => {
		const { seed } = wireSecretsRoundTrip()
		seed(unmigratedBlob({ work: { id: "w", apiProvider: "anthropic", rateLimitSeconds: 5 } }))
		mockGlobalState.get.mockReturnValue(12)

		await manager.initialize()

		expect(hoisted.files.user.profiles.work.rateLimitSeconds).toBe(5)
	})

	it("MOVES a legacy openAiHostHeader into the headers map", async () => {
		const { seed } = wireSecretsRoundTrip()
		seed(unmigratedBlob({ work: { id: "w", apiProvider: "openai", openAiHostHeader: "api.internal" } }))

		await manager.initialize()

		expect(hoisted.files.user.profiles.work.openAiHeaders).toEqual({ Host: "api.internal" })
		// The old key must go, or a later delete of the header silently
		// resurrects it on the next migration pass.
		expect(hoisted.files.user.profiles.work.openAiHostHeader).toBeUndefined()
	})

	it("leaves an existing headers map alone", async () => {
		const { seed } = wireSecretsRoundTrip()
		seed(
			unmigratedBlob({
				work: {
					id: "w",
					apiProvider: "openai",
					openAiHostHeader: "api.internal",
					openAiHeaders: { "X-Mine": "1" },
				},
			}),
		)

		await manager.initialize()

		expect(hoisted.files.user.profiles.work.openAiHeaders).toEqual({ "X-Mine": "1" })
	})

	it("seeds the consecutive-mistake limit and the todo-list toggle", async () => {
		const { seed } = wireSecretsRoundTrip()
		seed(unmigratedBlob({ work: { id: "w", apiProvider: "anthropic" } }))

		await manager.initialize()

		expect(hoisted.files.user.profiles.work.consecutiveMistakeLimit).toBeTypeOf("number")
		expect(hoisted.files.user.profiles.work.todoListEnabled).toBe(true)
	})

	it("records every migration as done so the next start is a no-op", async () => {
		const { seed } = wireSecretsRoundTrip()
		seed(unmigratedBlob({ work: { id: "w", apiProvider: "anthropic" } }))
		await manager.initialize()
		const writesAfterFirst = mockSecrets.store.mock.calls.length

		const second = new ProviderSettingsManager(mockContext)
		await second.initialize()

		expect(mockSecrets.store.mock.calls.length).toBe(writesAfterFirst)
	})

	it("REFUSES to delete an org-locked profile rather than appearing to succeed", async () => {
		wireSecretsRoundTrip()
		hoisted.files.org = {
			version: 1,
			profiles: { corp: { id: "c", apiProvider: "anthropic" }, other: { id: "o", apiProvider: "anthropic" } },
		} as never
		hoisted.locked.add("providers/corp")

		// The delete would only drop local secret overlays; the profile would
		// reappear on the next merge.
		await expect(manager.deleteConfig("corp")).rejects.toThrow(/locked by org policy/)
	})

	it("reports the org-locked names, sorted, for the settings UI to mark read-only", async () => {
		hoisted.files.org = {
			version: 1,
			profiles: { zeta: { id: "z" }, alpha: { id: "a" } },
		} as never
		hoisted.locked.add("providers/zeta")
		hoisted.locked.add("providers/alpha")

		await expect(manager.getLockedProfileNames()).resolves.toEqual(["alpha", "zeta"])
	})

	it("answers hasConfig from the COMPOSED set, not just the user file", async () => {
		wireSecretsRoundTrip()
		hoisted.files.org = { version: 1, profiles: { corp: { id: "c", apiProvider: "anthropic" } } } as never

		await expect(manager.hasConfig("corp")).resolves.toBe(true)
		await expect(manager.hasConfig("nope")).resolves.toBe(false)
	})

	it("round-trips the whole mode → profile map", async () => {
		wireSecretsRoundTrip()
		hoisted.files.user = { version: 1, profiles: { work: { id: "w", apiProvider: "anthropic" } } } as never

		await manager.setModeConfig("code" as never, "w")
		await manager.setModeConfig("architect" as never, "w")

		await expect(manager.getModeConfigId("code" as never)).resolves.toBe("w")
		await expect(manager.getModeConfigs()).resolves.toEqual({ code: "w", architect: "w" })
	})

	it("hands out a COPY of the mode map, so a caller cannot mutate the store", async () => {
		wireSecretsRoundTrip()
		hoisted.files.user = {
			version: 1,
			profiles: { work: { id: "w", apiProvider: "anthropic" } },
			modeApiConfigs: { code: "w" },
		} as never

		const first = await manager.getModeConfigs()
		first.code = "tampered"

		await expect(manager.getModeConfigs()).resolves.toEqual({ code: "w" })
	})

	it("getProfile finds a profile by ID as well as by name", async () => {
		wireSecretsRoundTrip()
		hoisted.files.user = { version: 1, profiles: { work: { id: "w-1", apiProvider: "anthropic" } } } as never

		await expect(manager.getProfile({ id: "w-1" })).resolves.toMatchObject({ name: "work", id: "w-1" })
	})

	it("NAMES what was missing when a lookup fails", async () => {
		wireSecretsRoundTrip()
		hoisted.files.user = { version: 1, profiles: { work: { id: "w-1" } } } as never

		await expect(manager.getProfile({ id: "nope" })).rejects.toThrow(/'nope' not found/)
		await expect(manager.getProfile({ name: "missing" })).rejects.toThrow(/'missing' not found/)
	})

	it("wraps a save failure in a named error rather than leaking the schema's", async () => {
		wireSecretsRoundTrip()

		await expect(manager.saveConfig("bad", { apiProvider: 42 } as never)).rejects.toThrow(/Failed to save config/)
	})

	it("import replaces the whole set in one write", async () => {
		wireSecretsRoundTrip()

		await manager.import({
			currentApiConfigName: "fresh",
			apiConfigs: { fresh: { id: "f", apiProvider: "anthropic", apiKey: "sk-imported" } },
		} as never)

		expect(hoisted.files.user.profiles.fresh).toMatchObject({ id: "f", apiProvider: "anthropic" })
		// The credential goes to the secrets blob, never to the file.
		expect(hoisted.files.user.profiles.fresh.apiKey).toBeUndefined()
		expect(JSON.stringify(lastBlob())).toContain("sk-imported")
	})
})
