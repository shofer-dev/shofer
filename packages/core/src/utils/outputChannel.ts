/** A log sink (structurally satisfied by `vscode.OutputChannel`; a headless host supplies its own). */
export interface OutputChannelLike {
	appendLine(value: string): void
}

/**
 * Standalone holder for the extension's output channel.
 *
 * Tools and other leaf modules import `getOutputChannel` from here rather than
 * from `../extension`. Importing the extension entrypoint pulls its entire graph
 * (→ `extension/api` → the provider → back into core) into the importer's module
 * initialization, which creates a circular dependency — a subclass evaluating
 * before its base class is defined throws "Class extends value undefined".
 * Keeping the channel in this dependency-free module breaks that cycle.
 *
 * `extension.ts` seeds the channel via {@link setOutputChannel} during
 * activation; callers before activation get `undefined`.
 */
let outputChannel: OutputChannelLike | undefined

/** Seed the shared output channel. Called once from `activate()`. */
export function setOutputChannel(channel: OutputChannelLike): void {
	outputChannel = channel
}

/**
 * Get the extension's output channel for logging.
 * Returns `undefined` if called before extension activation.
 */
export function getOutputChannel(): OutputChannelLike | undefined {
	return outputChannel
}
