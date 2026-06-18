import { writeFile } from "fs/promises"

import workerpool from "workerpool"

import { type StringifyAndWriteResult } from "./types"

/**
 * Pretty-print `value` to JSON and write it to `filePath` — entirely off the
 * extension-host thread.
 *
 * A workflow JSON export is the whole descendant task tree (every sub-task's
 * full conversation history), so serializing it on the main thread would block
 * the event loop for seconds and freeze the webview. The worker also performs
 * the file write so the (potentially multi-MB) string never has to be cloned
 * back across the worker boundary; only a byte count returns.
 */
async function stringifyAndWrite(value: unknown, filePath: string): Promise<StringifyAndWriteResult> {
	try {
		const json = JSON.stringify(value, null, 2)
		await writeFile(filePath, json, "utf8")
		return { success: true, bytes: Buffer.byteLength(json) }
	} catch (error) {
		return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
	}
}

workerpool.worker({ stringifyAndWrite })
