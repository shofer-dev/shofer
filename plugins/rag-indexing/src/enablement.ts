/**
 * Per-workspace enablement — "is indexing on for THIS folder", and what a folder nobody
 * has decided about defaults to.
 *
 * Two facts, and neither belongs in the plugin's `config`: the config is a single
 * user-edited object (and, for a synced plugin, one a controller may overwrite), while
 * this is per-workspace bookkeeping the user toggles from the indexer's own UI. It lived
 * in the editor's `workspaceState`/`globalState`; a plugin has `ctx.storage`, which also
 * works on a headless node where neither exists.
 *
 * Cached in memory and written through, because `isWorkspaceEnabled` is read on hot paths
 * (every state push) and must not become an await.
 */

import { runtime } from "./plugin-runtime.js"
import { codeIndexLog } from "./logging.js"

const FILE = "enablement.json"

interface Enablement {
	/** Absolute workspace path → the user's explicit choice for it. */
	workspaces: Record<string, boolean>
	/** What a workspace with no explicit choice does. */
	autoEnableDefault: boolean
}

let state: Enablement = { workspaces: {}, autoEnableDefault: true }
let loaded = false

/** Read the stored enablement once, at plugin start. */
export async function loadEnablement(): Promise<void> {
	const storage = runtime()?.storage
	if (!storage) {
		loaded = true
		return
	}
	try {
		if (await storage.exists(FILE)) {
			const parsed = JSON.parse(await storage.readFile(FILE)) as Partial<Enablement>
			state = {
				workspaces: parsed.workspaces ?? {},
				autoEnableDefault: parsed.autoEnableDefault ?? true,
			}
		}
	} catch (error) {
		// A corrupt file means "nobody has decided anything", which is the same as a fresh
		// install — better than refusing to start the indexer.
		codeIndexLog.warn(`[enablement] could not read ${FILE}: ${String(error)}`)
	}
	loaded = true
}

async function persist(): Promise<void> {
	const storage = runtime()?.storage
	if (!storage) return
	try {
		await storage.writeFile(FILE, JSON.stringify(state, null, 2))
	} catch (error) {
		codeIndexLog.error(`[enablement] could not write ${FILE}: ${String(error)}`)
	}
}

export function isWorkspaceIndexingEnabled(workspacePath: string): boolean {
	if (!loaded) return state.autoEnableDefault
	const explicit = state.workspaces[workspacePath]
	return explicit === undefined ? state.autoEnableDefault : explicit
}

export async function setWorkspaceIndexingEnabled(workspacePath: string, enabled: boolean): Promise<void> {
	state = { ...state, workspaces: { ...state.workspaces, [workspacePath]: enabled } }
	await persist()
}

export function getAutoEnableDefault(): boolean {
	return state.autoEnableDefault
}

export async function setAutoEnableDefault(enabled: boolean): Promise<void> {
	state = { ...state, autoEnableDefault: enabled }
	await persist()
}
