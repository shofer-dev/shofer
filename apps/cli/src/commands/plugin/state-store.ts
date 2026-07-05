import * as fs from "fs/promises"
import * as path from "path"

import type { PluginStateStore } from "@shofer/core/cli"

/**
 * A file-backed {@link PluginStateStore} over the CLI's global-state JSON — the same
 * flat key/value file the running agent's `FileMemento` uses
 * (`<globalStorage>/global-state.json`). The enabled/installed plugin allow-list is a
 * single array under `key` (`shofer.plugins.enabledPlugins`); reads and writes
 * preserve every other key in the file so the CLI's plugin commands stay in sync with
 * the agent without clobbering unrelated state (design §7, Phase 5.2).
 */
export function createFileStateStore(stateFile: string, key: string): PluginStateStore {
	const readAll = async (): Promise<Record<string, unknown>> => {
		try {
			const raw = await fs.readFile(stateFile, "utf-8")
			const parsed = JSON.parse(raw)
			return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
		} catch {
			return {}
		}
	}

	return {
		async getEnabledPlugins(): Promise<string[]> {
			const data = await readAll()
			const value = data[key]
			return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
		},
		async setEnabledPlugins(names: string[]): Promise<void> {
			const data = await readAll()
			data[key] = names
			await fs.mkdir(path.dirname(stateFile), { recursive: true })
			// Match FileMemento's on-disk format (2-space indent) so the file stays
			// human- and agent-readable identically whether the CLI or the agent wrote it.
			await fs.writeFile(stateFile, JSON.stringify(data, null, 2))
		},
	}
}
