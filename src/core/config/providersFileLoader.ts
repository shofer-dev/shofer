import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { z } from "zod"

import { PROFILE_SECRET_KEYS } from "@shofer/types"
import { isPathLocked, loadLockedManifestFromDisk, resolveScopeRoots, type ScopeRoots } from "@shofer/core"

/**
 * providersFileLoader — the file half of provider-profile storage.
 *
 * Provider profiles' **non-secret** configuration (provider, model id, base URL,
 * token limits, temperature, …) lives in `.shofer/providers.json`, read from the
 * three layered scopes and merged **per profile name**: `project > user > org`,
 * unless the org scope's `locked.json` names the profile (`providers/<name>`) or
 * the collection (`providers`) — then the org entry is final. The org scope may
 * also carry secret fields (an org-supplied `apiKey`): Shofer itself never
 * writes a secret to any file, but it honors one found there as the profile's
 * default credential — a locally-entered key (in the SecretStorage blob managed
 * by `ProviderSettingsManager`) wins over it.
 *
 * The **user** scope's file is the writable one: every profile edit made in the
 * UI persists there (secrets stripped), exactly as `writeScopeSetting` does for
 * `settings.json`. `currentApiConfigName` and `modeApiConfigs` ride the same
 * file and follow the same layered rule.
 */

/** Current on-disk version of `providers.json`. */
export const PROVIDERS_FILE_VERSION = 1

/** The per-scope providers filename inside `.shofer/`. */
export const PROVIDERS_FILE = "providers.json"

/**
 * Schema for one scope's `providers.json`. Profile bodies stay loosely typed
 * here — `ProviderSettingsManager` validates each composed profile against the
 * provider-settings schema, exactly as it always validated blob entries.
 */
export const providersFileSchema = z.object({
	version: z.literal(PROVIDERS_FILE_VERSION),
	currentApiConfigName: z.string().optional(),
	modeApiConfigs: z.record(z.string(), z.string()).optional(),
	profiles: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
})

export type ProvidersFile = z.infer<typeof providersFileSchema>

/** Where a merged profile's winning entry came from. */
export type ProviderProfileOrigin = "global" | "user" | "project"

/** The merged three-scope view of `providers.json`. */
export interface MergedProvidersFile {
	/** Effective current profile name from the files (project > user > org). */
	currentApiConfigName?: string
	/** Effective mode → profile-id map (deep-merged, more-specific wins per mode). */
	modeApiConfigs: Record<string, string>
	/** Winning profile body per name (may include org-supplied secret fields). */
	profiles: Record<string, Record<string, unknown>>
	/** Which scope each winning profile came from. */
	originByName: Record<string, ProviderProfileOrigin>
	/** Profile names the org scope locks (`providers`/`providers/<name>`). */
	lockedNames: Set<string>
}

/** Resolve the three scope roots the providers file lives in. */
export function resolveProviderScopeRoots(inputs: {
	globalStorageFsPath?: string
	workspaceFolder?: string
}): ScopeRoots {
	return resolveScopeRoots({
		globalStorageFsPath: inputs.globalStorageFsPath,
		homeDir: os.homedir(),
		workspaceFolder: inputs.workspaceFolder,
	})
}

/** Read + parse one scope's `providers.json`, failing closed to an empty file. */
async function readScopeProvidersFile(root: string | undefined): Promise<ProvidersFile> {
	const empty: ProvidersFile = { version: PROVIDERS_FILE_VERSION, profiles: {} }
	if (!root) {
		return empty
	}
	let raw: string
	try {
		raw = await fs.readFile(path.join(root, PROVIDERS_FILE), "utf8")
	} catch {
		return empty
	}
	try {
		const parsed = providersFileSchema.safeParse(JSON.parse(raw))
		return parsed.success ? parsed.data : empty
	} catch {
		return empty
	}
}

/**
 * Load and merge the three scopes' `providers.json` under the org scope's
 * `locked.json`.
 */
export async function loadMergedProvidersFile(roots: ScopeRoots): Promise<MergedProvidersFile> {
	const [org, user, project, manifest] = await Promise.all([
		readScopeProvidersFile(roots.global),
		readScopeProvidersFile(roots.user),
		readScopeProvidersFile(roots.project),
		loadLockedManifestFromDisk(roots.global),
	])

	const lockedNames = new Set<string>()
	const wholeLocked = isPathLocked("providers", manifest)

	const profiles: Record<string, Record<string, unknown>> = {}
	const originByName: Record<string, ProviderProfileOrigin> = {}

	const layers: Array<[ProviderProfileOrigin, ProvidersFile]> = [
		["global", org],
		["user", user],
		["project", project],
	]
	for (const [origin, file] of layers) {
		for (const [name, body] of Object.entries(file.profiles)) {
			const locked = name in org.profiles && (wholeLocked || isPathLocked(`providers/${name}`, manifest))
			if (locked) {
				lockedNames.add(name)
				if (origin !== "global") {
					continue // org entry is final
				}
			}
			profiles[name] = body
			originByName[name] = origin
		}
	}

	// Scalars: more-specific wins. Mode map: deep-merge per mode key.
	const currentApiConfigName = project.currentApiConfigName ?? user.currentApiConfigName ?? org.currentApiConfigName
	const modeApiConfigs = {
		...(org.modeApiConfigs ?? {}),
		...(user.modeApiConfigs ?? {}),
		...(project.modeApiConfigs ?? {}),
	}

	return { currentApiConfigName, modeApiConfigs, profiles, originByName, lockedNames }
}

/**
 * The secret fields (per `PROFILE_SECRET_KEYS`) present in a merged file
 * profile — i.e. org-supplied default credentials.
 */
export function fileSecretFields(profile: Record<string, unknown> | undefined): Record<string, string> {
	const out: Record<string, string> = {}
	if (!profile) {
		return out
	}
	for (const key of PROFILE_SECRET_KEYS) {
		const value = profile[key]
		if (typeof value === "string") {
			out[key] = value
		}
	}
	return out
}

/**
 * In-process per-file write chain (same rationale as `writeScopeSetting`): a
 * read-modify-write is not atomic across the read and the rename, so concurrent
 * writers to the same path are serialized.
 */
const writeChains = new Map<string, Promise<unknown>>()

function withFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
	const prev = writeChains.get(filePath) ?? Promise.resolve()
	const run = prev.then(task, task)
	writeChains.set(
		filePath,
		run.then(
			() => undefined,
			() => undefined,
		),
	)
	return run
}

/**
 * Atomically replace the **user** scope's `providers.json` with `doc` (temp file
 * + rename, sorted profile keys for stable diffs). Creates the directory if
 * missing.
 */
export async function writeUserProvidersFile(userRoot: string, doc: ProvidersFile): Promise<void> {
	const filePath = path.join(userRoot, PROVIDERS_FILE)

	return withFileLock(filePath, async () => {
		const sortedProfiles: Record<string, unknown> = {}
		for (const name of Object.keys(doc.profiles).sort()) {
			sortedProfiles[name] = doc.profiles[name]
		}
		const out = { ...doc, profiles: sortedProfiles }

		await fs.mkdir(userRoot, { recursive: true })
		const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
		await fs.writeFile(tmpPath, `${JSON.stringify(out, null, 2)}\n`, "utf8")
		await fs.rename(tmpPath, filePath)
	})
}

/** Delete the user scope's `providers.json` (reset path). Missing file is fine. */
export async function deleteUserProvidersFile(userRoot: string): Promise<void> {
	try {
		await fs.rm(path.join(userRoot, PROVIDERS_FILE))
	} catch {
		// absent already
	}
}
