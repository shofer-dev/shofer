import type { ExtensionContext } from "vscode"
import { z, ZodError } from "zod"
import deepEqual from "fast-deep-equal"

import {
	type ProviderSettingsWithId,
	providerSettingsWithIdSchema,
	discriminatedProviderSettingsWithIdSchema,
	PROFILE_SECRET_KEYS,
	ProviderSettingsEntry,
	DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
	getModelId,
	type ProviderName,
	isProviderName,
	isRetiredProvider,
} from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

import { Mode } from "@shofer/core"
import { buildApiHandler } from "@shofer/core"
import { configLog } from "@shofer/core"
import { getWorkspacePath } from "@shofer/core"

import {
	PROVIDERS_FILE_VERSION,
	deleteUserProvidersFile,
	fileSecretFields,
	loadMergedProvidersFile,
	resolveProviderScopeRoots,
	writeUserProvidersFile,
	type ProvidersFile,
} from "./providersFileLoader"

// Type-safe model migrations mapping
type ModelMigrations = {
	[K in ProviderName]?: Record<string, string>
}

const MODEL_MIGRATIONS: ModelMigrations = {} as const satisfies ModelMigrations

const migrationsSchema = z.object({
	rateLimitSecondsMigrated: z.boolean().optional(),
	openAiHeadersMigrated: z.boolean().optional(),
	consecutiveMistakeLimitMigrated: z.boolean().optional(),
	todoListEnabledMigrated: z.boolean().optional(),
	claudeCodeLegacySettingsMigrated: z.boolean().optional(),
})

export const providerProfilesSchema = z.object({
	currentApiConfigName: z.string(),
	apiConfigs: z.record(z.string(), providerSettingsWithIdSchema),
	modeApiConfigs: z.record(z.string(), z.string()).optional(),
	migrations: migrationsSchema.optional(),
})

export type ProviderProfiles = z.infer<typeof providerProfilesSchema>

/**
 * The SecretStorage blob's on-disk shape (version 2): **only** each profile's
 * locally-entered secret fields plus the migration flags. Everything non-secret
 * lives in the layered `.shofer/providers.json`
 * ([`providersFileLoader.ts`](providersFileLoader.ts)); `load()` composes the
 * two and `store()` splits them again. The legacy version-less shape (full
 * profiles in the blob) is detected on read and split out on the next store.
 */
const providerSecretsBlobSchema = z.object({
	version: z.literal(2),
	secrets: z.record(z.string(), z.record(z.string(), z.string())).default({}),
	migrations: migrationsSchema.optional(),
})

type ProviderSecretsBlob = z.infer<typeof providerSecretsBlobSchema>

export class ProviderSettingsManager {
	private static readonly SCOPE_PREFIX = "shofer_config_"
	private readonly defaultConfigId = this.generateId()

	/**
	 * No mode starts out linked to a profile. Modes are plugin/user data resolved at
	 * runtime, so there is no list to seed from here — and an unlinked mode needs no
	 * seed: switching to one keeps the active profile and records it as that mode's
	 * association (`ShoferProvider.handleUserModeSwitch`), which on a fresh install is
	 * the same "default" profile the old seed named.
	 */
	private readonly defaultModeApiConfigs: Record<string, string> = {}

	private readonly defaultProviderProfiles: ProviderProfiles = {
		currentApiConfigName: "default",
		apiConfigs: { default: { id: this.defaultConfigId } },
		modeApiConfigs: this.defaultModeApiConfigs,
		migrations: {
			rateLimitSecondsMigrated: true, // Mark as migrated on fresh installs
			openAiHeadersMigrated: true, // Mark as migrated on fresh installs
			consecutiveMistakeLimitMigrated: true, // Mark as migrated on fresh installs
			todoListEnabledMigrated: true, // Mark as migrated on fresh installs
			claudeCodeLegacySettingsMigrated: true, // Mark as migrated on fresh installs
		},
	}

	private readonly context: ExtensionContext

	constructor(context: ExtensionContext) {
		this.context = context

		// TODO: We really shouldn't have async methods in the constructor.
		this.initialize().catch((e: unknown) =>
			configLog.error("ProviderSettingsManager init error:", { error: String(e) }),
		)
	}

	public generateId() {
		return Math.random().toString(36).substring(2, 15)
	}

	/**
	 * Set when `load()` composed from a legacy full-profiles blob; `initialize`
	 * treats it as dirty so the very next store splits the blob into the
	 * providers file + v2 secrets blob instead of waiting for a user mutation.
	 */
	private legacyBlobSeen = false

	// Synchronize readConfig/writeConfig operations to avoid data loss.
	private _lock = Promise.resolve()
	private lock<T>(cb: () => Promise<T>) {
		const next = this._lock.then(cb)
		this._lock = next.catch(() => {}) as Promise<void>
		return next
	}

	/**
	 * Initialize config if it doesn't exist and run migrations.
	 */
	public async initialize() {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()

				if (!providerProfiles) {
					await this.store(this.defaultProviderProfiles)
					return
				}

				let isDirty = false

				// A legacy full-profiles blob is split into providers.json + the v2
				// secrets blob on this very pass, not on the next user mutation.
				if (this.legacyBlobSeen) {
					this.legacyBlobSeen = false
					isDirty = true
				}

				// Migrate existing installs to have a per-mode API config map. Starts
				// empty: a mode records its association on the first switch, so there is
				// nothing to seed and no mode list to seed it from.
				if (!providerProfiles.modeApiConfigs) {
					providerProfiles.modeApiConfigs = {}
					isDirty = true
				}

				// Apply model migrations for all providers
				if (this.applyModelMigrations(providerProfiles)) {
					isDirty = true
				}

				// Ensure all configs have IDs.
				for (const [_name, apiConfig] of Object.entries(providerProfiles.apiConfigs)) {
					if (!apiConfig.id) {
						apiConfig.id = this.generateId()
						isDirty = true
					}
				}

				// Ensure migrations field exists
				if (!providerProfiles.migrations) {
					providerProfiles.migrations = {
						rateLimitSecondsMigrated: false,
						openAiHeadersMigrated: false,
						consecutiveMistakeLimitMigrated: false,
						todoListEnabledMigrated: false,
						claudeCodeLegacySettingsMigrated: false,
					} // Initialize with default values
					isDirty = true
				}

				if (!providerProfiles.migrations.rateLimitSecondsMigrated) {
					await this.migrateRateLimitSeconds(providerProfiles)
					providerProfiles.migrations.rateLimitSecondsMigrated = true
					isDirty = true
				}

				if (!providerProfiles.migrations.openAiHeadersMigrated) {
					await this.migrateOpenAiHeaders(providerProfiles)
					providerProfiles.migrations.openAiHeadersMigrated = true
					isDirty = true
				}

				if (!providerProfiles.migrations.consecutiveMistakeLimitMigrated) {
					await this.migrateConsecutiveMistakeLimit(providerProfiles)
					providerProfiles.migrations.consecutiveMistakeLimitMigrated = true
					isDirty = true
				}

				if (!providerProfiles.migrations.todoListEnabledMigrated) {
					await this.migrateTodoListEnabled(providerProfiles)
					providerProfiles.migrations.todoListEnabledMigrated = true
					isDirty = true
				}

				if (!providerProfiles.migrations.claudeCodeLegacySettingsMigrated) {
					// These keys were used by the removed local Claude Code CLI wrapper.
					for (const apiConfig of Object.values(providerProfiles.apiConfigs)) {
						// Cast to string for comparison since "claude-code" is no longer a valid ProviderName
						if ((apiConfig.apiProvider as string) !== "claude-code") continue

						const config = apiConfig as unknown as Record<string, unknown>
						if ("claudeCodePath" in config) {
							delete config.claudeCodePath
							isDirty = true
						}
						if ("claudeCodeMaxOutputTokens" in config) {
							delete config.claudeCodeMaxOutputTokens
							isDirty = true
						}
					}

					providerProfiles.migrations.claudeCodeLegacySettingsMigrated = true
					isDirty = true
				}

				if (isDirty) {
					await this.store(providerProfiles)
				}
			})
		} catch (error) {
			throw new Error(`Failed to initialize config: ${error}`)
		}
	}

	private async migrateRateLimitSeconds(providerProfiles: ProviderProfiles) {
		try {
			let rateLimitSeconds: number | undefined

			try {
				rateLimitSeconds = await this.context.globalState.get<number>("rateLimitSeconds")
			} catch (error) {
				configLog.error("[MigrateRateLimitSeconds] Error getting global rate limit:", error)
			}

			if (rateLimitSeconds === undefined) {
				// Failed to get the existing value, use the default.
				rateLimitSeconds = 0
			}

			for (const [_name, apiConfig] of Object.entries(providerProfiles.apiConfigs)) {
				if (apiConfig.rateLimitSeconds === undefined) {
					apiConfig.rateLimitSeconds = rateLimitSeconds
				}
			}
		} catch (error) {
			configLog.error(`[MigrateRateLimitSeconds] Failed to migrate rate limit settings:`, error)
		}
	}

	private async migrateOpenAiHeaders(providerProfiles: ProviderProfiles) {
		try {
			for (const [_name, apiConfig] of Object.entries(providerProfiles.apiConfigs)) {
				// Use type assertion to access the deprecated property safely
				const configAny = apiConfig as any

				// Check if openAiHostHeader exists but openAiHeaders doesn't
				if (
					configAny.openAiHostHeader &&
					(!apiConfig.openAiHeaders || Object.keys(apiConfig.openAiHeaders || {}).length === 0)
				) {
					// Create the headers object with the Host value
					apiConfig.openAiHeaders = { Host: configAny.openAiHostHeader }

					// Delete the old property to prevent re-migration
					// This prevents the header from reappearing after deletion
					configAny.openAiHostHeader = undefined
				}
			}
		} catch (error) {
			configLog.error(`[MigrateOpenAiHeaders] Failed to migrate OpenAI headers:`, error)
		}
	}

	private async migrateConsecutiveMistakeLimit(providerProfiles: ProviderProfiles) {
		try {
			for (const [name, apiConfig] of Object.entries(providerProfiles.apiConfigs)) {
				if (apiConfig.consecutiveMistakeLimit == null) {
					apiConfig.consecutiveMistakeLimit = DEFAULT_CONSECUTIVE_MISTAKE_LIMIT
				}
			}
		} catch (error) {
			configLog.error(`[MigrateConsecutiveMistakeLimit] Failed to migrate consecutive mistake limit:`, error)
		}
	}

	private async migrateTodoListEnabled(providerProfiles: ProviderProfiles) {
		try {
			for (const [_name, apiConfig] of Object.entries(providerProfiles.apiConfigs)) {
				if (apiConfig.todoListEnabled === undefined) {
					apiConfig.todoListEnabled = true
				}
			}
		} catch (error) {
			configLog.error(`[MigrateTodoListEnabled] Failed to migrate todo list enabled setting:`, error)
		}
	}

	/**
	 * Apply model migrations for all providers
	 * Returns true if any migrations were applied
	 */
	private applyModelMigrations(providerProfiles: ProviderProfiles): boolean {
		let migrated = false

		try {
			for (const [_name, apiConfig] of Object.entries(providerProfiles.apiConfigs)) {
				// Skip configs without provider or model ID
				if (!apiConfig.apiProvider || !apiConfig.apiModelId) {
					continue
				}

				// Check if this provider has migrations (with type safety)
				const provider = apiConfig.apiProvider as ProviderName
				const providerMigrations = MODEL_MIGRATIONS[provider]
				if (!providerMigrations) {
					continue
				}

				// Check if the current model ID needs migration
				const newModelId = providerMigrations[apiConfig.apiModelId]
				if (newModelId && newModelId !== apiConfig.apiModelId) {
					configLog.info(
						`[ModelMigration] Migrating ${apiConfig.apiProvider} model from ${apiConfig.apiModelId} to ${newModelId}`,
					)
					apiConfig.apiModelId = newModelId
					migrated = true
				}
			}
		} catch (error) {
			configLog.error(`[ModelMigration] Failed to apply model migrations:`, error)
		}

		return migrated
	}

	/**
	 * Clean model ID by removing prefix before "/"
	 */
	private cleanModelId(modelId: string | undefined): string | undefined {
		if (!modelId) return undefined

		// Check for "/" and take the part after it
		if (modelId.includes("/")) {
			return modelId.split("/").pop()
		}

		return modelId
	}

	/**
	 * List all available configs with metadata.
	 */
	public async listConfig(): Promise<ProviderSettingsEntry[]> {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()

				return Object.entries(providerProfiles.apiConfigs).map(([name, apiConfig]) => ({
					name,
					id: apiConfig.id || "",
					apiProvider: apiConfig.apiProvider,
					modelId: this.cleanModelId(getModelId(apiConfig)),
				}))
			})
		} catch (error) {
			throw new Error(`Failed to list configs: ${error}`)
		}
	}

	/**
	 * Save a config with the given name.
	 * Preserves the ID from the input 'config' object if it exists,
	 * otherwise generates a new one (for creation scenarios).
	 */
	public async saveConfig(name: string, config: ProviderSettingsWithId): Promise<string> {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				// Preserve the existing ID if this is an update to an existing config.
				const existingId = providerProfiles.apiConfigs[name]?.id
				const id = config.id || existingId || this.generateId()

				// For active providers, filter out settings from other providers.
				// For retired providers, preserve full profile fields (including legacy
				// provider-specific keys) to avoid data loss — passthrough() keeps
				// unknown keys that strict parse() would strip.
				const filteredConfig =
					typeof config.apiProvider === "string" && isRetiredProvider(config.apiProvider)
						? providerSettingsWithIdSchema.passthrough().parse(config)
						: discriminatedProviderSettingsWithIdSchema.parse(config)
				providerProfiles.apiConfigs[name] = { ...filteredConfig, id }
				await this.store(providerProfiles)
				return id
			})
		} catch (error) {
			throw new Error(`Failed to save config: ${error}`)
		}
	}

	public async getProfile(
		params: { name: string } | { id: string },
	): Promise<ProviderSettingsWithId & { name: string }> {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				let name: string
				let providerSettings: ProviderSettingsWithId

				if ("name" in params) {
					name = params.name

					if (!providerProfiles.apiConfigs[name]) {
						throw new Error(`Config with name '${name}' not found`)
					}

					providerSettings = providerProfiles.apiConfigs[name]
				} else {
					const id = params.id

					const entry = Object.entries(providerProfiles.apiConfigs).find(
						([_, apiConfig]) => apiConfig.id === id,
					)

					if (!entry) {
						throw new Error(`Config with ID '${id}' not found`)
					}

					name = entry[0]
					providerSettings = entry[1]
				}

				return { name, ...providerSettings }
			})
		} catch (error) {
			throw new Error(`Failed to get profile: ${error instanceof Error ? error.message : error}`)
		}
	}

	/**
	 * Activate a profile by name or ID.
	 */
	public async activateProfile(
		params: { name: string } | { id: string },
	): Promise<ProviderSettingsWithId & { name: string }> {
		const { name, ...providerSettings } = await this.getProfile(params)

		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				providerProfiles.currentApiConfigName = name
				await this.store(providerProfiles)
				return { name, ...providerSettings }
			})
		} catch (error) {
			throw new Error(`Failed to activate profile: ${error instanceof Error ? error.message : error}`)
		}
	}

	/**
	 * Delete a config by name.
	 */
	public async deleteConfig(name: string) {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()

				if (!providerProfiles.apiConfigs[name]) {
					throw new Error(`Config '${name}' not found`)
				}

				if (Object.keys(providerProfiles.apiConfigs).length === 1) {
					throw new Error(`Cannot delete the last remaining configuration`)
				}

				delete providerProfiles.apiConfigs[name]
				await this.store(providerProfiles)
			})
		} catch (error) {
			throw new Error(`Failed to delete config: ${error}`)
		}
	}

	/**
	 * Check if a config exists by name.
	 */
	public async hasConfig(name: string) {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				return name in providerProfiles.apiConfigs
			})
		} catch (error) {
			throw new Error(`Failed to check config existence: ${error}`)
		}
	}

	/**
	 * Set the API config for a specific mode.
	 */
	public async setModeConfig(mode: Mode, configId: string) {
		try {
			return await this.lock(async () => {
				const providerProfiles = await this.load()
				// Ensure the per-mode config map exists
				if (!providerProfiles.modeApiConfigs) {
					providerProfiles.modeApiConfigs = {}
				}
				// Assign the chosen config ID to this mode
				providerProfiles.modeApiConfigs[mode] = configId
				await this.store(providerProfiles)
			})
		} catch (error) {
			throw new Error(`Failed to set mode config: ${error}`)
		}
	}

	/**
	 * Get the API config ID for a specific mode.
	 */
	public async getModeConfigId(mode: Mode) {
		try {
			return await this.lock(async () => {
				const { modeApiConfigs } = await this.load()
				return modeApiConfigs?.[mode]
			})
		} catch (error) {
			throw new Error(`Failed to get mode config: ${error}`)
		}
	}

	/**
	 * Get the full mode → API-config-id map. This store is the single source of
	 * truth for per-mode associations; the webview receives it as a projection
	 * via `getStateToPostToWebview` and never persists its own copy.
	 */
	public async getModeConfigs(): Promise<Record<string, string>> {
		try {
			return await this.lock(async () => {
				const { modeApiConfigs } = await this.load()
				return { ...(modeApiConfigs ?? {}) }
			})
		} catch (error) {
			throw new Error(`Failed to get mode configs: ${error}`)
		}
	}

	public async export() {
		try {
			return await this.lock(async () => {
				const profiles = providerProfilesSchema.parse(await this.load())
				const configs = profiles.apiConfigs
				for (const name in configs) {
					const apiProvider = configs[name].apiProvider

					if (typeof apiProvider === "string" && isRetiredProvider(apiProvider)) {
						// Preserve retired-provider profiles as-is to prevent dropping legacy fields.
						continue
					}

					// Avoid leaking properties from other active providers.
					configs[name] = discriminatedProviderSettingsWithIdSchema.parse(configs[name])

					// If it has no apiProvider, skip filtering
					if (!configs[name].apiProvider) {
						continue
					}

					// Try to build an API handler to get model information
					try {
						const apiHandler = buildApiHandler(configs[name])
						const modelInfo = apiHandler.getModel().info

						// Check if the model supports reasoning budgets
						const supportsReasoningBudget =
							modelInfo.supportsReasoningBudget || modelInfo.requiredReasoningBudget

						// If the model doesn't support reasoning budgets, remove the token fields
						if (!supportsReasoningBudget) {
							delete configs[name].modelMaxTokens
							delete configs[name].modelMaxThinkingTokens
						}
					} catch (error) {
						// If we can't build the API handler or get model info, skip filtering
						// to avoid accidental data loss from incomplete configurations
						configLog.warn(`Skipping token field filtering for config '${name}': ${error}`)
					}
				}
				return profiles
			})
		} catch (error) {
			throw new Error(`Failed to export provider profiles: ${error}`)
		}
	}

	public async import(providerProfiles: ProviderProfiles) {
		try {
			return await this.lock(() => this.store(providerProfiles))
		} catch (error) {
			throw new Error(`Failed to import provider profiles: ${error}`)
		}
	}

	/**
	 * Reset provider profiles: delete the secrets blob and the user scope's
	 * `providers.json` (org/project scope files are not ours to delete).
	 */
	public async resetAllConfigs() {
		return await this.lock(async () => {
			await this.context.secrets.delete(this.secretsKey)
			const { user } = this.resolveRoots()
			if (user) {
				await deleteUserProvidersFile(user)
			}
		})
	}

	private get secretsKey() {
		return `${ProviderSettingsManager.SCOPE_PREFIX}api_config`
	}

	/** The `.shofer/` scope roots the providers file is read from / written to. */
	private resolveRoots() {
		let workspaceFolder: string | undefined
		try {
			workspaceFolder = getWorkspacePath() || undefined
		} catch {
			workspaceFolder = undefined
		}
		return resolveProviderScopeRoots({
			globalStorageFsPath: this.context.globalStorageUri?.fsPath,
			workspaceFolder,
		})
	}

	/**
	 * Parse the SecretStorage blob. Returns the v2 secrets blob, or — when the
	 * content still has the legacy full-profiles shape — the legacy profiles so
	 * `load()` can compose from them once (`store()` then splits them out).
	 */
	private parseSecretsBlob(content: string): { blob: ProviderSecretsBlob; legacy?: ProviderProfiles } {
		const parsed = JSON.parse(content)

		const v2 = providerSecretsBlobSchema.safeParse(parsed)
		if (v2.success) {
			return { blob: v2.data }
		}

		// Legacy shape: full profiles in the blob (pre-providers.json).
		const legacyRaw = providerProfilesSchema
			.extend({ apiConfigs: z.record(z.string(), z.any()), cloudProfileIds: z.array(z.string()).optional() })
			.parse(parsed)
		const apiConfigs: Record<string, ProviderSettingsWithId> = {}
		for (const [name, apiConfig] of Object.entries(legacyRaw.apiConfigs)) {
			const validated = this.validateProfile(apiConfig)
			if (validated) {
				apiConfigs[name] = validated
			}
		}
		const legacy: ProviderProfiles = {
			currentApiConfigName: legacyRaw.currentApiConfigName,
			apiConfigs,
			modeApiConfigs: legacyRaw.modeApiConfigs,
			migrations: legacyRaw.migrations,
		}
		return { blob: { version: 2, secrets: {}, migrations: legacyRaw.migrations }, legacy }
	}

	/** Sanitize + schema-validate one profile body; `undefined` when unusable. */
	private validateProfile(apiConfig: unknown): ProviderSettingsWithId | undefined {
		// First, sanitize invalid apiProvider values before parsing.
		// This handles removed providers (like "glama") gracefully.
		const sanitizedConfig = this.sanitizeProviderConfig(apiConfig)

		// For retired providers, use passthrough() to preserve legacy
		// provider-specific fields (e.g. groqApiKey, deepInfraModelId)
		// that strict parse() would strip.
		const providerValue =
			typeof sanitizedConfig === "object" && sanitizedConfig !== null && "apiProvider" in sanitizedConfig
				? (sanitizedConfig as Record<string, unknown>).apiProvider
				: undefined
		const schema =
			typeof providerValue === "string" && isRetiredProvider(providerValue)
				? providerSettingsWithIdSchema.passthrough()
				: providerSettingsWithIdSchema
		const result = schema.safeParse(sanitizedConfig)
		return result.success ? result.data : undefined
	}

	/**
	 * Compose the effective profiles: the merged three-scope
	 * `.shofer/providers.json` supplies every non-secret field (and any
	 * org-supplied secret default), the SecretStorage blob overlays each
	 * profile's locally-entered secret fields (local key wins).
	 */
	private async load(): Promise<ProviderProfiles> {
		try {
			const content = await this.context.secrets.get(this.secretsKey)
			const { blob, legacy } = content
				? this.parseSecretsBlob(content)
				: { blob: { version: 2, secrets: {} } as ProviderSecretsBlob, legacy: undefined }

			const merged = await loadMergedProvidersFile(this.resolveRoots())

			if (legacy) {
				this.legacyBlobSeen = true
				// One-shot composition from the legacy blob: its profiles win over
				// file entries (it was the sole source of truth when written); the
				// next store() splits non-secret fields out to the user file.
				const apiConfigs: Record<string, ProviderSettingsWithId> = {}
				for (const [name, body] of Object.entries(merged.profiles)) {
					const validated = this.validateProfile(body)
					if (validated) {
						apiConfigs[name] = validated
					}
				}
				Object.assign(apiConfigs, legacy.apiConfigs)
				return {
					currentApiConfigName: legacy.currentApiConfigName,
					apiConfigs,
					modeApiConfigs: { ...merged.modeApiConfigs, ...(legacy.modeApiConfigs ?? {}) },
					migrations: legacy.migrations,
				}
			}

			const apiConfigs: Record<string, ProviderSettingsWithId> = {}
			for (const [name, body] of Object.entries(merged.profiles)) {
				const validated = this.validateProfile(body)
				if (!validated) {
					continue
				}
				const localSecrets = blob.secrets[name]
				apiConfigs[name] = localSecrets ? { ...validated, ...localSecrets } : validated
			}

			if (Object.keys(apiConfigs).length === 0) {
				return this.defaultProviderProfiles
			}

			const currentApiConfigName =
				merged.currentApiConfigName && merged.currentApiConfigName in apiConfigs
					? merged.currentApiConfigName
					: Object.keys(apiConfigs)[0]

			return {
				currentApiConfigName,
				apiConfigs,
				modeApiConfigs: merged.modeApiConfigs,
				migrations: blob.migrations,
			}
		} catch (error) {
			if (error instanceof ZodError) {
				TelemetryService.instance.captureSchemaValidationError({
					schemaName: "ProviderProfiles",
					error,
				})
			}

			throw new Error(`Failed to read provider profiles: ${error}`)
		}
	}

	/**
	 * Sanitizes a provider config by resetting unknown apiProvider values.
	 * Retired providers are preserved.
	 * This handles cases where a user had a provider selected that was later removed
	 * from the extension (e.g., "glama").
	 */
	private sanitizeProviderConfig(apiConfig: unknown): unknown {
		if (typeof apiConfig !== "object" || apiConfig === null) {
			return apiConfig
		}

		const config = apiConfig as Record<string, unknown>

		const apiProvider = config.apiProvider

		// Check if apiProvider is set and if it's still recognized (active or retired)
		if (
			apiProvider !== undefined &&
			(typeof apiProvider !== "string" || (!isProviderName(apiProvider) && !isRetiredProvider(apiProvider)))
		) {
			configLog.info(
				`[ProviderSettingsManager] Sanitizing unknown provider "${config.apiProvider}" - resetting to undefined`,
			)
			// Return a new config object without the invalid apiProvider
			// This effectively resets the profile so the user can select a valid provider
			const { apiProvider, ...restConfig } = config
			return restConfig
		}

		return apiConfig
	}

	/**
	 * Split-write the composed profiles: non-secret fields to the **user**
	 * scope's `.shofer/providers.json`, locally-entered secret fields to the
	 * SecretStorage blob (v2).
	 *
	 * Scope discipline on the file side:
	 *   - a profile the org scope **locks** is never persisted (the merge makes
	 *     the org entry final; a shadowed user copy would only mislead);
	 *   - a profile whose winning entry came from the org/project scope and is
	 *     unchanged is not copied into the user file (a copy would freeze
	 *     upstream updates);
	 *   - everything else — user-created profiles and user edits of unlocked
	 *     foreign-scope profiles — lands in the user file.
	 *
	 * Secret discipline: a secret field goes to the blob only when it differs
	 * from the merged file's value for that profile, so an org-supplied key that
	 * the user never replaced stays file-sourced (and org rotation of it takes
	 * effect); a locally-entered key is stored and wins.
	 */
	private async store(providerProfiles: ProviderProfiles) {
		try {
			const roots = this.resolveRoots()
			const merged = await loadMergedProvidersFile(roots)

			const userDoc: ProvidersFile = {
				version: PROVIDERS_FILE_VERSION,
				currentApiConfigName: providerProfiles.currentApiConfigName,
				modeApiConfigs: providerProfiles.modeApiConfigs ?? {},
				profiles: {},
			}
			const blob: ProviderSecretsBlob = {
				version: 2,
				secrets: {},
				migrations: providerProfiles.migrations,
			}

			for (const [name, profile] of Object.entries(providerProfiles.apiConfigs)) {
				const fileEntry = merged.profiles[name]
				const fileSecrets = fileSecretFields(fileEntry)

				// Split: secret fields that differ from the file's value go to the
				// blob; the file copy carries everything else.
				const nonSecret: Record<string, unknown> = {}
				const localSecrets: Record<string, string> = {}
				for (const [key, value] of Object.entries(profile)) {
					if (value === undefined) {
						continue
					}
					if ((PROFILE_SECRET_KEYS as readonly string[]).includes(key)) {
						if (typeof value === "string" && fileSecrets[key] !== value) {
							localSecrets[key] = value
						}
						continue
					}
					nonSecret[key] = value
				}
				if (Object.keys(localSecrets).length > 0) {
					blob.secrets[name] = localSecrets
				}

				if (merged.lockedNames.has(name)) {
					continue
				}
				const origin = merged.originByName[name]
				if (
					(origin === "global" || origin === "project") &&
					fileEntry &&
					deepEqual(nonSecret, this.stripSecretFields(fileEntry))
				) {
					continue
				}
				userDoc.profiles[name] = nonSecret
			}

			if (!roots.user) {
				throw new Error("No user scope root (~/.shofer) available")
			}
			await writeUserProvidersFile(roots.user, userDoc)
			await this.context.secrets.store(this.secretsKey, JSON.stringify(blob, null, 2))
		} catch (error) {
			throw new Error(`Failed to write provider profiles: ${error}`)
		}
	}

	/** A copy of `profile` without its secret fields (for file-diff comparisons). */
	private stripSecretFields(profile: Record<string, unknown>): Record<string, unknown> {
		const out: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(profile)) {
			if (value === undefined || (PROFILE_SECRET_KEYS as readonly string[]).includes(key)) {
				continue
			}
			out[key] = value
		}
		return out
	}

}
