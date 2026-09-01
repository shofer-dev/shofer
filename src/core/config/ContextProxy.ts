import * as os from "os"

import type * as vscode from "vscode"
import { ZodError } from "zod"

import {
	PROVIDER_SETTINGS_KEYS,
	GLOBAL_SETTINGS_KEYS,
	SECRET_STATE_KEYS,
	GLOBAL_STATE_KEYS,
	GLOBAL_SECRET_KEYS,
	PROFILE_SECRET_KEYS,
	type ProviderSettings,
	type GlobalSettings,
	type SecretState,
	type GlobalState,
	type ShoferSettings,
	providerSettingsSchema,
	globalSettingsSchema,
	isSecretStateKey,
	isProfileSecretKey,
	isProviderName,
	isRetiredProvider,
	TypedEmitter,
} from "@shofer/types"
import { TelemetryService } from "@shofer/telemetry"

import { configLog as logger, getWorkspacePath, type LayeredSettings } from "@shofer/core"
import { supportPrompt } from "@shofer/types"

import {
	loadLayeredOverlay,
	loadLockedManifest,
	readScopeSettingsFile,
	resolveScopeRoots,
	seedScopeSettingsFile,
	writeScopeSetting,
	type ScopeRoots,
} from "./layeredSettingsLoader"
import { ScopeWatcher } from "./scopeWatcher"
import type { ProviderSettingsManager } from "./ProviderSettingsManager"

/**
 * The `.shofer/` filenames whose change must reach a running host: the settings
 * layers and the global scope's lock manifest (unlocking a key changes the
 * effective value of a file this host already read).
 */
const WATCHED_SCOPE_FILES = ["settings.json", "locked.json", "shofermodes", "providers.json"] as const

type GlobalStateKey = keyof GlobalState
type SecretStateKey = keyof SecretState
type ShoferSettingsKey = keyof ShoferSettings

const PASS_THROUGH_STATE_KEYS = ["taskHistory"]

export const isPassThroughStateKey = (key: string) => PASS_THROUGH_STATE_KEYS.includes(key)

/**
 * Part B: the raw `globalState` marker recording the NAME of the provider profile
 * whose settings are currently loaded into the live `apiConfiguration`.
 *
 * This is deliberately distinct from the persisted `currentApiConfigName` (the
 * name-only *default* profile, which `setDefaultApiConfiguration` changes WITHOUT
 * touching the live config) and from the blob's own `currentApiConfigName` (updated
 * only by `activateProfile`, not by `upsertProviderProfile`). Neither reliably
 * identifies the live profile — each can be shown, by construction, to diverge from
 * it — so per-profile secrets are keyed off this dedicated marker on restart. It is
 * internal bookkeeping, not part of the settings contract, so it lives outside
 * `globalSettingsSchema`/`GLOBAL_STATE_KEYS` (read/written via raw `globalState`, an
 * access `ContextProxy` itself is exempted to make — see the No Ad-Hoc VS Code Config
 * Reads Rule).
 */
const LIVE_API_CONFIG_PROFILE_KEY = "liveApiConfigProfileName"

const globalSettingsExportSchema = globalSettingsSchema.omit({
	taskHistory: true,
	listApiConfigMeta: true,
	currentApiConfigName: true,
})

export class ContextProxy {
	private readonly originalContext: vscode.ExtensionContext

	private stateCache: GlobalState
	private secretCache: SecretState
	private _isInitialized = false

	// Part B: the SINGLE ProviderSettingsManager instance, threaded post-construction
	// (ContextProxy.initialize runs before any PSM exists). It is the persisted source
	// of truth for the per-profile LLM secrets in PROFILE_SECRET_KEYS; secretCache holds
	// only the current profile's copy in memory, sourced from this on restart. Never
	// construct a second PSM here — its per-instance write lock would let two writers
	// race the profiles blob.
	private providerSettingsManager?: ProviderSettingsManager

	// Part E3: additive, read-only layered `.shofer/settings.json` overlay merged
	// across the global/user/project scopes (see layeredSettingsLoader). A key
	// present here wins over `globalState` in getValue; an empty overlay (the
	// case whenever no `.shofer/settings.json` exists at any scope) leaves every
	// read as pure `globalState` fallback, preserving current behavior exactly.
	private layeredOverlay: LayeredSettings = {}

	// H8: EventEmitter so consumers can subscribe to settings changes
	// without polling.  Fires with the changed key whenever a global-state
	// or secret value is written through ContextProxy.
	private readonly _onDidChangeEmitter = new TypedEmitter<{ key: string }>()
	public readonly onDidChange = this._onDidChangeEmitter.event

	// Fires when the layered overlay was re-read because a `.shofer/` file changed on
	// disk (never on this host's own `setValue`). Views subscribe to this to re-render
	// an external edit; subscribing to `onDidChange` instead would re-render on every
	// write this host makes, which is most of them.
	private readonly _onDidRefreshOverlayEmitter = new TypedEmitter<{ keys: string[] }>()
	public readonly onDidRefreshOverlay = this._onDidRefreshOverlayEmitter.event

	// Fires with the watched `.shofer/` filenames a change touched, whatever they hold.
	// This is the seam for the scope files ContextProxy does not itself own —
	// `shofermodes` (CustomModesManager) and `providers.json` reconcile from it.
	private readonly _onDidChangeScopeFilesEmitter = new TypedEmitter<{ files: string[] }>()
	public readonly onDidChangeScopeFiles = this._onDidChangeScopeFilesEmitter.event

	// Watches the three `.shofer/` scopes; undefined until startScopeWatcher().
	private scopeWatcher?: ScopeWatcher

	constructor(context: vscode.ExtensionContext) {
		this.originalContext = context
		this.stateCache = {}
		this.secretCache = {}
		this._isInitialized = false
	}

	public get isInitialized() {
		return this._isInitialized
	}

	public async initialize() {
		for (const key of GLOBAL_STATE_KEYS) {
			try {
				// Revert to original assignment
				this.stateCache[key] = this.originalContext.globalState.get(key)
			} catch (error) {
				logger.error(`Error loading global ${key}: ${error instanceof Error ? error.message : String(error)}`)
			}
		}

		const promises = [
			...SECRET_STATE_KEYS.map(async (key) => {
				try {
					this.secretCache[key] = await this.originalContext.secrets.get(key)
				} catch (error) {
					logger.error(
						`Error loading secret ${key}: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}),
			...GLOBAL_SECRET_KEYS.map(async (key) => {
				try {
					this.secretCache[key] = await this.originalContext.secrets.get(key)
				} catch (error) {
					logger.error(
						`Error loading global secret ${key}: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}),
		]

		await Promise.all(promises)

		// Migration: Check for old nested image generation settings and migrate them
		await this.migrateImageGenerationSettings()

		// Migration: Sanitize invalid/removed API providers
		await this.migrateInvalidApiProvider()

		// Migration: Move legacy customCondensingPrompt to customSupportPrompts
		await this.migrateLegacyCondensingPrompt()

		// Migration: Clear old default condensing prompt so users get the improved v2 default
		await this.migrateOldDefaultCondensingPrompt()

		// One-time seed: materialize `globalState`-resident settings into the
		// user scope's file so the file layer is complete (no-op once it exists).
		await this.seedUserScopeFromGlobalState()

		// Part E3: build the read-only layered `.shofer/settings.json` overlay.
		// Additive — a failure or a total absence of files leaves it empty, so
		// every getValue stays a pure globalState read.
		await this.refreshLayeredOverlay()

		this._isInitialized = true
	}

	/**
	 * Part B: thread the SINGLE {@link ProviderSettingsManager} into the proxy after
	 * both have been constructed (init runs before any PSM exists — see the field
	 * doc). Once attached, the current profile's per-profile LLM secrets
	 * (`PROFILE_SECRET_KEYS`) are sourced from the profiles blob rather than from
	 * individual `SecretStorage` entries, and the now-redundant individual entries are
	 * pruned once (a one-time de-dup migration). Idempotent and fail-soft: any error
	 * leaves `secretCache` on whatever it loaded at {@link initialize} time.
	 */
	public async attachProviderSettingsManager(providerSettingsManager: ProviderSettingsManager): Promise<void> {
		this.providerSettingsManager = providerSettingsManager
		await this.loadCurrentProfileSecretsFromBlob()
	}

	/**
	 * Resolve the live profile and load its `PROFILE_SECRET_KEYS` from the profiles
	 * blob into `secretCache`, then prune the stale individual `SecretStorage` entries.
	 *
	 * The live profile is identified by the {@link LIVE_API_CONFIG_PROFILE_KEY} marker
	 * (written on every {@link setProviderSettings} that loads a profile) so a restart
	 * never pairs profile A's non-secret settings (restored from `globalState`) with
	 * profile B's key. On the very first boot after this change the marker is absent;
	 * fall back to the persisted `currentApiConfigName` and seed the marker so
	 * subsequent boots use the authoritative value.
	 */
	private async loadCurrentProfileSecretsFromBlob(): Promise<void> {
		const psm = this.providerSettingsManager
		if (!psm) {
			return
		}

		const marker = this.originalContext.globalState.get<string>(LIVE_API_CONFIG_PROFILE_KEY)
		const liveName = marker ?? (this.getGlobalState("currentApiConfigName") as string | undefined)
		if (!liveName) {
			return
		}

		try {
			const profile = (await psm.getProfile({ name: liveName })) as Record<string, unknown>
			for (const key of PROFILE_SECRET_KEYS) {
				this.secretCache[key] = profile[key] as string | undefined
			}

			if (!marker) {
				await this.originalContext.globalState.update(LIVE_API_CONFIG_PROFILE_KEY, liveName)
			}

			// One-time de-dup migration: the blob is now the sole persisted store for
			// these keys, so drop any individual SecretStorage copies. Safe because the
			// values were just confirmed loadable from the blob; a subsequent write is
			// what re-establishes them if a profile is edited.
			await this.pruneProfileSecretStorageEntries()
		} catch (error) {
			logger.error(
				`Error loading current profile "${liveName}" secrets from blob: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}

	/**
	 * Delete the individual `SecretStorage` entries for `PROFILE_SECRET_KEYS`. These are
	 * the denormalized copies that Part B removes; the profiles blob is their sole
	 * persisted store. Fail-soft per key.
	 */
	private async pruneProfileSecretStorageEntries(): Promise<void> {
		await Promise.all(
			PROFILE_SECRET_KEYS.map(async (key) => {
				try {
					await this.originalContext.secrets.delete(key)
				} catch (error) {
					logger.error(
						`Error pruning stale individual secret ${key}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					)
				}
			}),
		)
	}

	/**
	 * (Re)load the layered `.shofer/settings.json` overlay from disk (Part E3).
	 *
	 * Resolves the three scope roots from the host's base paths (env
	 * `SHOFER_GLOBAL_DIR` / extension global-storage for global, `~/.shofer` for
	 * user, the open workspace for project), reads + merges them, and caches the
	 * effective overlay. Fails closed: any error leaves the overlay empty (or,
	 * on a later refresh, unchanged is preferable but an empty overlay still only
	 * degrades to the pre-overlay globalState fallback — never to wrong data).
	 *
	 * This never writes to disk; writes still flow to `globalState`/`setValue`.
	 */
	public async refreshLayeredOverlay(): Promise<string[]> {
		const previous = this.layeredOverlay
		try {
			this.layeredOverlay = await loadLayeredOverlay(this.resolveScopeRoots())
		} catch (error) {
			logger.error(
				`Error loading layered .shofer settings overlay: ${error instanceof Error ? error.message : String(error)}`,
			)
			this.layeredOverlay = {}
		}

		const changed: string[] = []
		for (const key of new Set([...Object.keys(previous), ...Object.keys(this.layeredOverlay)])) {
			const before = previous[key as keyof LayeredSettings]
			const after = this.layeredOverlay[key as keyof LayeredSettings]
			if (JSON.stringify(before) !== JSON.stringify(after)) {
				changed.push(key)
			}
		}
		return changed
	}

	/**
	 * Start watching the three `.shofer/` scopes so a change made **outside this host**
	 * — by a person editing `~/.shofer/settings.json`, by another pod sharing the
	 * volume, or by a ConfigMap rewrite — is applied without a restart. The scopes and
	 * their merge order are documented in `docs/settings_overlay.md`.
	 *
	 * Idempotent. Each applied change fires {@link onDidChange} per changed key (so the
	 * existing consumers — config-sync broadcast to nodes, and anything else keyed off a
	 * settings write — see a file edit exactly as they see a `setValue`) and
	 * {@link onDidRefreshOverlay} once with the whole set, which is the event a view
	 * should re-render from.
	 *
	 * The overlay only ever *narrows* to `globalState` on failure, so a watcher that
	 * cannot start (or a file that disappears) degrades to the pre-watcher behaviour
	 * rather than to wrong values.
	 */
	public startScopeWatcher(): void {
		if (this.scopeWatcher) {
			return
		}
		this.scopeWatcher = new ScopeWatcher({
			roots: this.resolveScopeRoots(),
			files: WATCHED_SCOPE_FILES,
			onChange: (files) => {
				this._onDidChangeScopeFilesEmitter.fire({ files })
				void this.applyExternalScopeChange()
			},
		})
	}

	/**
	 * Whether `key`'s effective value comes from the layered `.shofer/` overlay rather
	 * than this host's own `globalState`.
	 *
	 * The overlay wins in {@link getValue}, so a `true` here means a local write to that
	 * key would be shadowed and never take effect. Surfaces are expected to use this to
	 * present the value as read-only instead of offering an edit that silently does
	 * nothing (a control the user cannot change must not look like one they can).
	 */
	public isManagedByFileLayer(key: ShoferSettingsKey): boolean {
		return Object.prototype.hasOwnProperty.call(this.layeredOverlay, key)
	}

	/** Re-read the overlay after a watched file changed, and announce what moved. */
	private async applyExternalScopeChange(): Promise<void> {
		const changed = await this.refreshLayeredOverlay()
		if (changed.length === 0) {
			return
		}
		logger.info(`Layered .shofer settings changed on disk: ${changed.join(", ")}`)
		for (const key of changed) {
			this._onDidChangeEmitter.fire({ key })
		}
		this._onDidRefreshOverlayEmitter.fire({ keys: changed })
	}

	/** Stop the scope watcher (extension deactivation / test isolation). */
	public dispose(): void {
		this.scopeWatcher?.dispose()
		this.scopeWatcher = undefined
	}

	/**
	 * Resolve the three `.shofer/` scope roots from the host's base paths. Shared
	 * by the read overlay ({@link refreshLayeredOverlay}) and the write-through
	 * ({@link writeThroughToUserScope}) so both agree on where each scope lives.
	 */
	private resolveScopeRoots(): ScopeRoots {
		let workspaceFolder: string | undefined
		try {
			workspaceFolder = getWorkspacePath() || undefined
		} catch {
			workspaceFolder = undefined
		}

		return resolveScopeRoots({
			globalStorageFsPath: this.originalContext.globalStorageUri?.fsPath,
			homeDir: os.homedir(),
			workspaceFolder,
		})
	}

	/**
	 * Write-through: mirror a globalSettings write into the **user** scope's
	 * `~/.shofer/settings.json` so the file layer is authoritative on the next
	 * read, then refresh the overlay so `getValue` reflects it immediately.
	 *
	 * Unconditional (the file is created on the first write): the layered files
	 * are the source of truth and `globalState` is the runtime cache, so every
	 * install is file-backed from its first settings write. A key locked by the
	 * global scope's `locked.json` is not persisted (the read overlay makes
	 * global win anyway). Failure-isolated: a file-layer error (read-only home,
	 * exotic filesystem) degrades to cache-only persistence for that write
	 * rather than failing the setValue.
	 */
	private async writeThroughToUserScope<K extends ShoferSettingsKey>(
		key: K,
		value: ShoferSettings[K],
	): Promise<void> {
		try {
			const { roots, root } = this.resolveWriteScope(key)
			if (!root) {
				return
			}

			const manifest = await loadLockedManifest(roots.global)
			const result = await writeScopeSetting(root, key as string, value, manifest)
			if (result.persisted) {
				await this.refreshLayeredOverlay()
			}
		} catch (error) {
			logger.error(
				`Failed to write-through ${String(key)} to the scope settings file: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Where a write of `key` lands: the project scope when the user selected
	 * `settingsWriteScope: "project"` and a workspace is open, the user scope
	 * otherwise. `settingsWriteScope` itself always persists at the user scope —
	 * routing the selector into the project file would commit one user's preference
	 * for everyone.
	 *
	 * Shared by {@link writeThroughToUserScope} and {@link getWriteScopeValue} so a
	 * read of "what does the write scope already hold" can never disagree with where
	 * the write actually goes.
	 */
	private resolveWriteScope(key: ShoferSettingsKey): { roots: ScopeRoots; root?: string; isProject: boolean } {
		const roots = this.resolveScopeRoots()
		const isProject =
			key !== "settingsWriteScope" && this.getValue("settingsWriteScope") === "project" && !!roots.project
		return { roots, root: isProject ? roots.project : roots.user, isProject }
	}

	/**
	 * The WRITE SCOPE's own stored value for `key` — deliberately **not** the merged
	 * effective view {@link getValue} serves.
	 *
	 * A caller that merges into a record-valued setting (`alwaysAllowGroups`) must
	 * start from the map as the write scope itself stores it. Merging into the
	 * effective view instead would copy every entry the org-global and other scopes
	 * contribute into this scope's own file, where they would then shadow those
	 * scopes' later changes forever — the file would keep asserting a value the org
	 * has since moved on from, and nothing would say so.
	 *
	 * Resolution, in order:
	 *   1. the write scope's `settings.json`, when it declares the key — the file
	 *      layer is the source of truth;
	 *   2. otherwise this host's own `globalState`, which is the runtime cache of
	 *      the same writes (`setValue` writes both) and is therefore the right
	 *      answer on a host whose file layer has not been materialised yet;
	 *   3. except when the write scope is the PROJECT scope, where step 2 is
	 *      skipped and the answer is `undefined`: `globalState` holds this user's
	 *      own accumulated preferences, and seeding a committed, shared project
	 *      file from them would publish them to everyone working in the repo.
	 *
	 * Returns `undefined` when no scope-local value exists; the caller decides what
	 * an empty starting point means.
	 */
	public async getWriteScopeValue<K extends ShoferSettingsKey>(key: K): Promise<ShoferSettings[K] | undefined> {
		const { root, isProject } = this.resolveWriteScope(key)

		if (root) {
			const own = await readScopeSettingsFile(root)
			if (Object.prototype.hasOwnProperty.call(own, key)) {
				return own[key as keyof LayeredSettings] as ShoferSettings[K]
			}
		}

		return isProject ? undefined : (this.getGlobalState(key as GlobalStateKey) as ShoferSettings[K])
	}

	/**
	 * One-time migration seed (config-cleanup.md Decision 3): if the user scope
	 * has no `settings.json` yet but `globalState` holds settings values, write
	 * them all to the file once, so the file layer is complete and authoritative
	 * from this session on — not only for keys touched after the cutover. A
	 * fresh install (empty `globalState`) seeds nothing and the file appears on
	 * the first real write instead. Create-only and failure-isolated.
	 */
	private async seedUserScopeFromGlobalState(): Promise<void> {
		try {
			const roots = this.resolveScopeRoots()
			if (!roots.user) {
				return
			}

			const values: Record<string, unknown> = {}
			for (const key of GLOBAL_SETTINGS_KEYS) {
				if (!this.isWriteThroughKey(key)) {
					continue
				}
				const value = this.stateCache[key as GlobalStateKey]
				if (value !== undefined) {
					values[key] = value
				}
			}
			if (Object.keys(values).length === 0) {
				return
			}

			if (await seedScopeSettingsFile(roots.user, values)) {
				logger.info(
					`Seeded ~/.shofer/settings.json with ${Object.keys(values).length} settings from globalState`,
				)
			}
		} catch (error) {
			logger.error(
				`Failed to seed ~/.shofer/settings.json: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * A globalSettings key eligible for user-scope write-through: a non-secret key
	 * that lives in `globalSettingsSchema` (so a subsequent read parses it) and is
	 * not a large pass-through blob (`taskHistory`) that has no business in a
	 * hand-editable settings file.
	 */
	private isWriteThroughKey(key: ShoferSettingsKey): boolean {
		return (
			!isSecretStateKey(key) &&
			!isPassThroughStateKey(key) &&
			(GLOBAL_SETTINGS_KEYS as readonly string[]).includes(key as string)
		)
	}

	/**
	 * Migrates the legacy customCondensingPrompt to the new customSupportPrompts structure
	 * and removes the legacy field.
	 *
	 * Note: Only true customizations are migrated. If the legacy prompt equals the default,
	 * we skip the migration to avoid pinning users to an old default if the default changes.
	 */
	private async migrateLegacyCondensingPrompt() {
		try {
			const legacyPrompt = this.originalContext.globalState.get<string>("customCondensingPrompt")
			if (legacyPrompt) {
				const currentSupportPrompts =
					this.originalContext.globalState.get<Record<string, string>>("customSupportPrompts") || {}

				// Only migrate if:
				// 1. The new location doesn't already have a value
				// 2. The legacy prompt is a true customization (not equal to the default)
				// This prevents pinning users to an old default if the default prompt changes.
				const isCustomized = legacyPrompt.trim() !== supportPrompt.default.CONDENSE.trim()
				if (!currentSupportPrompts.CONDENSE && isCustomized) {
					logger.info("Migrating customized legacy customCondensingPrompt to customSupportPrompts")
					const updatedPrompts = { ...currentSupportPrompts, CONDENSE: legacyPrompt }
					await this.originalContext.globalState.update("customSupportPrompts", updatedPrompts)
					this.stateCache.customSupportPrompts = updatedPrompts
				} else if (!isCustomized) {
					logger.info("Skipping migration: legacy customCondensingPrompt equals the default prompt")
				}

				// Always remove the legacy field
				await this.originalContext.globalState.update("customCondensingPrompt", undefined)
				this.stateCache.customCondensingPrompt = undefined
			}
		} catch (error) {
			logger.error(
				`Error during customCondensingPrompt migration: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Clears the old v1 default condensing prompt from customSupportPrompts.CONDENSE if present.
	 *
	 * Before PR #10873 "Intelligent Context Condensation v2", the default condensing prompt was
	 * a simpler 6-section format. Users who had this old default saved in their settings would
	 * be stuck with it instead of getting the improved v2 default (which includes analysis tags,
	 * error tracking, all user messages, and better task continuity).
	 *
	 * This migration uses fingerprinting to detect the old v1 default - checking for key
	 * identifying phrases unique to v1 and absence of v2-specific features. This is more
	 * lenient than exact matching and handles whitespace variations.
	 */
	private async migrateOldDefaultCondensingPrompt() {
		try {
			const currentSupportPrompts =
				this.originalContext.globalState.get<Record<string, string>>("customSupportPrompts") || {}

			const savedCondensePrompt = currentSupportPrompts.CONDENSE

			if (savedCondensePrompt && this.isOldV1DefaultCondensePrompt(savedCondensePrompt)) {
				logger.info(
					"Clearing old v1 default condensing prompt from customSupportPrompts.CONDENSE - user will now get the improved v2 default",
				)

				// Remove the CONDENSE key from customSupportPrompts
				const { CONDENSE: _, ...remainingPrompts } = currentSupportPrompts
				const updatedPrompts = Object.keys(remainingPrompts).length > 0 ? remainingPrompts : undefined

				await this.originalContext.globalState.update("customSupportPrompts", updatedPrompts)
				this.stateCache.customSupportPrompts = updatedPrompts
			}
		} catch (error) {
			logger.error(
				`Error during old default condensing prompt migration: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Detects if a prompt is the old v1 default condensing prompt using fingerprinting.
	 * This is more lenient than exact matching - it checks for key identifying phrases
	 * unique to v1 and absence of v2-specific features.
	 *
	 * V1 characteristics:
	 * - Exactly 6 numbered sections (1-6)
	 * - Contains specific section headers like "Previous Conversation", "Current Work", etc.
	 * - Does NOT contain v2-specific features like "<analysis>", "SYSTEM OPERATION", etc.
	 */
	private isOldV1DefaultCondensePrompt(prompt: string): boolean {
		// Key phrases unique to the v1 default (must ALL be present)
		const v1RequiredPhrases = [
			"Your task is to create a detailed summary of the conversation so far",
			"1. Previous Conversation:",
			"2. Current Work:",
			"3. Key Technical Concepts:",
			"4. Relevant Files and Code:",
			"5. Problem Solving:",
			"6. Pending Tasks and Next Steps:",
			"Output only the summary of the conversation so far",
		]

		// V2-specific features (if ANY are present, this is NOT v1 default)
		const v2Features = [
			"<analysis>",
			"SYSTEM OPERATION",
			"Errors and fixes",
			"All user messages",
			"7.", // v2 has more than 6 sections
			"8.",
			"9.",
		]

		// Check that all v1 required phrases are present
		const hasAllV1Phrases = v1RequiredPhrases.every((phrase) => prompt.toLowerCase().includes(phrase.toLowerCase()))

		// Check that no v2 features are present
		const hasNoV2Features = v2Features.every((feature) => !prompt.toLowerCase().includes(feature.toLowerCase()))

		return hasAllV1Phrases && hasNoV2Features
	}

	/**
	 * Migrates unknown apiProvider values by clearing them from storage.
	 * Retired providers are preserved so users can keep historical configuration.
	 */
	private async migrateInvalidApiProvider() {
		try {
			const apiProvider = this.stateCache.apiProvider
			const isKnownProvider =
				typeof apiProvider === "string" && (isProviderName(apiProvider) || isRetiredProvider(apiProvider))

			if (apiProvider !== undefined && !isKnownProvider) {
				logger.info(`[ContextProxy] Found invalid provider "${apiProvider}" in storage - clearing it`)
				// Clear the invalid provider from both cache and storage
				this.stateCache.apiProvider = undefined
				await this.originalContext.globalState.update("apiProvider", undefined)
			}
		} catch (error) {
			logger.error(
				`Error during invalid API provider migration: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Migrates old nested openRouterImageGenerationSettings to the new flattened structure
	 */
	private async migrateImageGenerationSettings() {
		try {
			// Check if there's an old nested structure
			const oldNestedSettings = this.originalContext.globalState.get<any>("openRouterImageGenerationSettings")

			if (oldNestedSettings && typeof oldNestedSettings === "object") {
				logger.info("Migrating old nested image generation settings to flattened structure")

				// Migrate the API key if it exists and we don't already have one
				if (oldNestedSettings.openRouterApiKey && !this.secretCache.openRouterImageApiKey) {
					await this.originalContext.secrets.store(
						"openRouterImageApiKey",
						oldNestedSettings.openRouterApiKey,
					)
					this.secretCache.openRouterImageApiKey = oldNestedSettings.openRouterApiKey
					logger.info("Migrated openRouterImageApiKey to secrets")
				}

				// Migrate the selected model if it exists and we don't already have one
				if (oldNestedSettings.selectedModel && !this.stateCache.openRouterImageGenerationSelectedModel) {
					await this.originalContext.globalState.update(
						"openRouterImageGenerationSelectedModel",
						oldNestedSettings.selectedModel,
					)
					this.stateCache.openRouterImageGenerationSelectedModel = oldNestedSettings.selectedModel
					logger.info("Migrated openRouterImageGenerationSelectedModel to global state")
				}

				// Clean up the old nested structure
				await this.originalContext.globalState.update("openRouterImageGenerationSettings", undefined)
				logger.info("Removed old nested openRouterImageGenerationSettings")
			}
		} catch (error) {
			logger.error(
				`Error during image generation settings migration: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	public get extensionUri() {
		return this.originalContext.extensionUri
	}

	public get extensionPath() {
		return this.originalContext.extensionPath
	}

	public get globalStorageUri() {
		return this.originalContext.globalStorageUri
	}

	public get logUri() {
		return this.originalContext.logUri
	}

	public get extension() {
		return this.originalContext.extension
	}

	public get extensionMode() {
		return this.originalContext.extensionMode
	}

	/**
	 * ExtensionContext.globalState
	 * https://code.visualstudio.com/api/references/vscode-api#ExtensionContext.globalState
	 */

	getGlobalState<K extends GlobalStateKey>(key: K): GlobalState[K]
	getGlobalState<K extends GlobalStateKey>(key: K, defaultValue: GlobalState[K]): GlobalState[K]
	getGlobalState<K extends GlobalStateKey>(key: K, defaultValue?: GlobalState[K]): GlobalState[K] {
		if (isPassThroughStateKey(key)) {
			const value = this.originalContext.globalState.get<GlobalState[K]>(key)
			return value === undefined || value === null ? defaultValue : value
		}

		const value = this.stateCache[key]
		return value !== undefined ? value : defaultValue
	}

	updateGlobalState<K extends GlobalStateKey>(key: K, value: GlobalState[K]) {
		if (isPassThroughStateKey(key)) {
			return this.originalContext.globalState.update(key, value)
		}

		this.stateCache[key] = value
		const result = this.originalContext.globalState.update(key, value)
		this._onDidChangeEmitter.fire({ key })
		return result
	}

	private getAllGlobalState(): GlobalState {
		return Object.fromEntries(GLOBAL_STATE_KEYS.map((key) => [key, this.getGlobalState(key)]))
	}

	/**
	 * ExtensionContext.secrets
	 * https://code.visualstudio.com/api/references/vscode-api#ExtensionContext.secrets
	 */

	getSecret(key: SecretStateKey) {
		return this.secretCache[key]
	}

	storeSecret(key: SecretStateKey, value?: string) {
		// Update cache.
		this.secretCache[key] = value

		// Part B: a per-profile LLM secret's sole persisted store is the profiles blob
		// (written by ProviderSettingsManager). Do NOT mirror it into an individual
		// SecretStorage entry — secretCache is its in-memory holder for the current
		// profile only. Only the GLOBAL_SECRET_KEYS (openRouterImageApiKey,
		// pluginSecrets) keep individual entries below.
		if (isProfileSecretKey(key)) {
			this._onDidChangeEmitter.fire({ key })
			return Promise.resolve()
		}

		// Write directly to context.
		const result =
			value === undefined
				? this.originalContext.secrets.delete(key)
				: this.originalContext.secrets.store(key, value)
		this._onDidChangeEmitter.fire({ key })
		return result
	}

	/**
	 * Refresh secrets from storage and update cache
	 * This is useful when you need to ensure the cache has the latest values
	 */
	async refreshSecrets(): Promise<void> {
		// Part B: only the cross-profile secrets keep individual SecretStorage
		// entries — reload those from storage. The per-profile LLM secrets
		// (PROFILE_SECRET_KEYS) live in the profiles blob, so re-reading individual
		// entries would clobber the cached current-profile values with `undefined`;
		// reload them from the blob instead.
		const individualSecretKeys = [
			...SECRET_STATE_KEYS.filter((key) => !isProfileSecretKey(key)),
			...GLOBAL_SECRET_KEYS,
		]
		await Promise.all(
			individualSecretKeys.map(async (key) => {
				try {
					this.secretCache[key] = await this.originalContext.secrets.get(key)
				} catch (error) {
					logger.error(
						`Error refreshing secret ${key}: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}),
		)
		await this.loadCurrentProfileSecretsFromBlob()
	}

	private getAllSecretState(): SecretState {
		return Object.fromEntries([
			...SECRET_STATE_KEYS.map((key) => [key, this.getSecret(key as SecretStateKey)]),
			...GLOBAL_SECRET_KEYS.map((key) => [key, this.getSecret(key as SecretStateKey)]),
		])
	}

	/**
	 * GlobalSettings
	 */

	public getGlobalSettings(): GlobalSettings {
		const values = this.getValues()

		try {
			return globalSettingsSchema.parse(values)
		} catch (error) {
			if (error instanceof ZodError) {
				TelemetryService.instance.captureSchemaValidationError({ schemaName: "GlobalSettings", error })
			}

			return GLOBAL_SETTINGS_KEYS.reduce((acc, key) => ({ ...acc, [key]: values[key] }), {} as GlobalSettings)
		}
	}

	/**
	 * ProviderSettings
	 */

	public getProviderSettings(): ProviderSettings {
		const values = this.getValues()

		// Sanitize invalid/removed apiProvider values before parsing
		// This handles cases where a user had a provider selected that was later removed
		// from the extension (e.g., "glama"). We sanitize here to avoid repeated
		// schema validation errors that can cause infinite loops in telemetry.
		const sanitizedValues = this.sanitizeProviderValues(values)

		try {
			return providerSettingsSchema.parse(sanitizedValues)
		} catch (error) {
			if (error instanceof ZodError) {
				TelemetryService.instance.captureSchemaValidationError({ schemaName: "ProviderSettings", error })
			}

			return PROVIDER_SETTINGS_KEYS.reduce(
				(acc, key) => ({ ...acc, [key]: sanitizedValues[key] }),
				{} as ProviderSettings,
			)
		}
	}

	/**
	 * Sanitizes provider values by resetting unknown apiProvider values.
	 * Active and retired providers are preserved.
	 */
	private sanitizeProviderValues(values: ShoferSettings): ShoferSettings {
		// Remove legacy Claude Code CLI wrapper keys that may still exist in global state.
		// These keys were used by a removed local CLI runner and are no longer part of ProviderSettings.
		const legacyKeys = ["claudeCodePath", "claudeCodeMaxOutputTokens"] as const

		let sanitizedValues = values
		for (const key of legacyKeys) {
			if (key in sanitizedValues) {
				const copy = { ...sanitizedValues } as Record<string, unknown>
				delete copy[key as string]
				sanitizedValues = copy as ShoferSettings
			}
		}

		const isKnownProvider =
			typeof values.apiProvider === "string" &&
			(isProviderName(values.apiProvider) || isRetiredProvider(values.apiProvider))

		if (values.apiProvider !== undefined && !isKnownProvider) {
			logger.info(`[ContextProxy] Sanitizing invalid provider "${values.apiProvider}" - resetting to undefined`)
			// Return a new values object without the invalid apiProvider
			const { apiProvider, ...restValues } = sanitizedValues
			return restValues as ShoferSettings
		}
		return sanitizedValues
	}

	/**
	 * Load a provider profile's settings into the live `apiConfiguration`.
	 *
	 * When `profileName` is given the call represents loading a named profile as the
	 * *current* profile: it records the {@link LIVE_API_CONFIG_PROFILE_KEY} marker (so a
	 * restart can re-source this profile's secrets from the blob) and clears any stale
	 * per-profile secrets left in `secretCache` from a previously-active profile that
	 * `values` does not re-specify. Callers that only patch the live config (e.g. tests,
	 * OAuth token merges) omit `profileName` and neither the marker nor the secret-clear
	 * fires.
	 */
	public async setProviderSettings(values: ProviderSettings, profileName?: string) {
		// Explicitly clear out any old API configuration values before that
		// might not be present in the new configuration.
		// If a value is not present in the new configuration, then it is assumed
		// that the setting's value should be `undefined` and therefore we
		// need to remove it from the state cache if it exists.

		// Ensure openAiHeaders is always an object even when empty
		// This is critical for proper serialization/deserialization through IPC
		if (values.openAiHeaders !== undefined) {
			// Check if it's empty or null
			if (!values.openAiHeaders || Object.keys(values.openAiHeaders).length === 0) {
				values.openAiHeaders = {}
			}
		}

		// On a named-profile load, clear any per-profile secret still cached from the
		// previously-active profile so switching A→B never leaves A's key behind when
		// B's profile simply omits that key. Gated on `profileName` so ad-hoc patches
		// don't wipe the live secrets.
		const clearedProfileSecrets =
			profileName !== undefined
				? PROFILE_SECRET_KEYS.filter((key) => this.secretCache[key] !== undefined).reduce(
						(acc, key) => ({ ...acc, [key]: undefined }),
						{} as ProviderSettings,
					)
				: {}

		await this.setValues({
			...PROVIDER_SETTINGS_KEYS.filter((key) => !isSecretStateKey(key))
				.filter((key) => !!this.stateCache[key])
				.reduce((acc, key) => ({ ...acc, [key]: undefined }), {} as ProviderSettings),
			...clearedProfileSecrets,
			...values,
		})

		if (profileName !== undefined) {
			await this.originalContext.globalState.update(LIVE_API_CONFIG_PROFILE_KEY, profileName)
		}
	}

	/**
	 * ShoferSettings
	 */

	// Part E4: secrets and provider profiles are untouched here — secrets still go
	// to `SecretStorage`, provider-only keys still to `globalState`. For a
	// globalSettings key we keep the `globalState` write (the hot cache) AND, when
	// the user scope has opted into file-backed settings, mirror it into
	// `~/.shofer/settings.json` so the layered file layer becomes authoritative on
	// the next read. A global-locked key is not mirrored (the overlay makes the
	// global value win regardless). The scope selector in the Settings UI (writing
	// to user vs project) remains future work — see todos/config-cleanup.md.
	public async setValue<K extends ShoferSettingsKey>(key: K, value: ShoferSettings[K]) {
		if (isSecretStateKey(key)) {
			return this.storeSecret(key as SecretStateKey, value as string)
		}

		const result = this.updateGlobalState(key as GlobalStateKey, value)

		if (this.isWriteThroughKey(key)) {
			await this.writeThroughToUserScope(key, value)
		}

		return result
	}

	public getValue<K extends ShoferSettingsKey>(key: K): ShoferSettings[K] {
		if (isSecretStateKey(key)) {
			return this.getSecret(key as SecretStateKey) as ShoferSettings[K]
		}

		// Part E3: an unlocked/locked key resolved by the layered `.shofer/`
		// overlay wins over globalState. The overlay is empty whenever no
		// `.shofer/settings.json` exists, so this branch is inert in every
		// current deployment and the read falls through to globalState unchanged.
		if (Object.prototype.hasOwnProperty.call(this.layeredOverlay, key)) {
			return this.layeredOverlay[key as keyof LayeredSettings] as ShoferSettings[K]
		}

		return this.getGlobalState(key as GlobalStateKey) as ShoferSettings[K]
	}

	public getValues(): ShoferSettings {
		const globalState = this.getAllGlobalState()
		const secretState = this.getAllSecretState()

		// The layered `.shofer/` overlay wins over globalState here for the same reason
		// it does in getValue — otherwise the two disagree, and every consumer that reads
		// the whole snapshot rather than a key silently ignores file-based settings.
		// Secrets stay last: they are never in the overlay by construction.
		return { ...globalState, ...this.layeredOverlay, ...secretState }
	}

	public async setValues(values: ShoferSettings) {
		const entries = Object.entries(values) as [ShoferSettingsKey, unknown][]
		await Promise.all(entries.map(([key, value]) => this.setValue(key, value)))
	}

	/**
	 * Import / Export
	 */

	public async export(): Promise<GlobalSettings | undefined> {
		try {
			const globalSettings = globalSettingsExportSchema.parse(this.getValues())

			// Exports should only contain global settings, so this skips project custom modes (those exist in the .roomode folder)
			globalSettings.customModes = globalSettings.customModes?.filter((mode) => mode.source === "global")

			return Object.fromEntries(Object.entries(globalSettings).filter(([_, value]) => value !== undefined))
		} catch (error) {
			if (error instanceof ZodError) {
				TelemetryService.instance.captureSchemaValidationError({ schemaName: "GlobalSettings", error })
			}

			return undefined
		}
	}

	/**
	 * Resets all global state, secrets, and in-memory caches.
	 * This clears all data from both the in-memory caches and the VSCode storage.
	 * @returns A promise that resolves when all reset operations are complete
	 */
	public async resetAllState() {
		// Clear in-memory caches
		this.stateCache = {}
		this.secretCache = {}

		await Promise.all([
			...GLOBAL_STATE_KEYS.map((key) => this.originalContext.globalState.update(key, undefined)),
			this.originalContext.globalState.update(LIVE_API_CONFIG_PROFILE_KEY, undefined),
			...SECRET_STATE_KEYS.map((key) => this.originalContext.secrets.delete(key)),
			...GLOBAL_SECRET_KEYS.map((key) => this.originalContext.secrets.delete(key)),
		])

		await this.initialize()
		// Re-source the current profile's secrets from the blob after the reset
		// wiped the caches (no-op until a PSM has been attached).
		await this.loadCurrentProfileSecretsFromBlob()
	}

	private static _instance: ContextProxy | null = null

	static get instance() {
		if (!this._instance) {
			throw new Error("ContextProxy not initialized")
		}

		return this._instance
	}

	static async getInstance(context: vscode.ExtensionContext) {
		if (this._instance) {
			return this._instance
		}

		this._instance = new ContextProxy(context)
		await this._instance.initialize()

		return this._instance
	}
}
