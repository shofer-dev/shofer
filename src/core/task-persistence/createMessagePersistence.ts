import { FileSystemMessagePersistence, type MessagePersistencePort } from "./PersistencePort"
import { SqliteMessagePersistence, isSqliteAvailable } from "./SqliteMessagePersistence"

export type MessageBackend = "filesystem" | "sqlite"

/**
 * Build the message-persistence backend (§5). The default is the flat-file
 * backend (zero behavior change). Selecting `"sqlite"` returns the SQLite backend
 * **only if** `node:sqlite` is available on this runtime; otherwise it falls back
 * to flat-file, so opting in can never break a host that lacks SQLite.
 *
 * Switching the default to SQLite is the remaining (deliberate) §5 rollout step —
 * gated on runtime confidence (extension-host Node) + a migration plan.
 */
export async function createMessagePersistence(
	globalStoragePath: string,
	backend: MessageBackend = "filesystem",
): Promise<MessagePersistencePort> {
	if (backend === "sqlite" && (await isSqliteAvailable())) {
		return new SqliteMessagePersistence(globalStoragePath)
	}
	return new FileSystemMessagePersistence(globalStoragePath)
}
