import { writeFile } from "fs/promises"

import workerpool from "workerpool"

import { stringifyAndWriteResultSchema } from "../workers/types"
import { utilLog } from "./logging/subsystems"

let pool: workerpool.Pool | null | undefined = undefined

export type StringifyJsonToFileOptions = {
	useWorker?: boolean
}

/**
 * Serialize `value` to pretty-printed JSON and write it to `filePath`, off the
 * extension-host thread, returning the number of bytes written.
 *
 * Mirrors {@link countTokens}: a lazily-created single-worker pool with a
 * synchronous in-process fallback if the worker can't be spawned or errors.
 * The structured-clone of `value` into the worker is still an O(n) main-thread
 * cost, but the heavy `JSON.stringify` + pretty-print — and the big-string
 * round-trip — are not: the worker writes the file itself and returns only a
 * byte count, so the event loop stays free to keep the webview responsive.
 */
export async function stringifyJsonToFile(
	value: unknown,
	filePath: string,
	{ useWorker = true }: StringifyJsonToFileOptions = {},
): Promise<number> {
	// Lazily create the worker pool if it doesn't exist.
	if (useWorker && typeof pool === "undefined") {
		pool = workerpool.pool(__dirname + "/workers/exportJson.js", {
			maxWorkers: 1,
			maxQueueSize: 10,
		})
	}

	// If the worker pool doesn't exist or the caller opted out, write in-process.
	if (!useWorker || !pool) {
		return writeInProcess(value, filePath)
	}

	try {
		const data = await pool.exec("stringifyAndWrite", [value, filePath])
		const result = stringifyAndWriteResultSchema.parse(data)

		if (!result.success) {
			throw new Error(result.error)
		}

		return result.bytes
	} catch (error) {
		pool = null
		utilLog.error(String(error))
		return writeInProcess(value, filePath)
	}
}

async function writeInProcess(value: unknown, filePath: string): Promise<number> {
	const json = JSON.stringify(value, null, 2)
	await writeFile(filePath, json, "utf8")
	return Buffer.byteLength(json)
}
