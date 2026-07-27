/**
 * The plugin's logger — the `codeIndexLog` the indexer used when it lived in core.
 *
 * Bound once at `initialize` to `ctx.host.log`, so everything the indexer writes lands in
 * its own `Plugin:rag-indexing` log category and can be filtered independently of core's
 * subsystems (Settings → Logging). Before binding — and in a unit test that never
 * constructs a plugin context — calls go nowhere rather than throwing: a logger that can
 * fail is a logger nobody dares call from an error path.
 */

/** The subset of the host logger the indexer uses. */
export interface IndexerLogger {
	debug(message: string, ...args: unknown[]): void
	info(message: string, ...args: unknown[]): void
	warn(message: string, ...args: unknown[]): void
	error(message: string, ...args: unknown[]): void
}

const NOOP: IndexerLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
}

let sink: IndexerLogger = NOOP

/** Point the indexer's logging at the host (`ctx.host.log`). */
export function setLogger(logger: IndexerLogger | undefined): void {
	sink = logger ?? NOOP
}

/**
 * The module-level logger every indexer file imports.
 *
 * A stable object that forwards to whatever sink is currently bound, so a module can
 * capture it at import time — before the plugin is initialized — and still log to the
 * host afterwards.
 */
export const codeIndexLog: IndexerLogger = {
	debug: (message, ...args) => sink.debug(message, ...args),
	info: (message, ...args) => sink.info(message, ...args),
	warn: (message, ...args) => sink.warn(message, ...args),
	error: (message, ...args) => sink.error(message, ...args),
}

/** Aliases kept for the git-history half, which logged under its own names. */
export const gitIndexLog = codeIndexLog
export const gitLog = codeIndexLog
