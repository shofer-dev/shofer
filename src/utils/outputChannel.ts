import type * as vscode from "vscode"

/**
 * Standalone holder for the extension's output channel.
 *
 * Tools and other leaf modules import `getOutputChannel` from here rather than
 * from `../extension`. Importing the extension entrypoint pulls its entire
 * graph (→ `extension/api` → `core/workflow` → `WorkflowTask`) into the
 * importer's module initialization, which creates a circular dependency:
 * `WorkflowTask extends Task` evaluates before `Task` is defined and throws
 * "Class extends value undefined". Keeping the channel in this dependency-free
 * module breaks that cycle.
 *
 * `extension.ts` seeds the channel via {@link setOutputChannel} during
 * activation; callers before activation get `undefined`.
 */
let outputChannel: vscode.OutputChannel | undefined

/** Seed the shared output channel. Called once from `activate()`. */
export function setOutputChannel(channel: vscode.OutputChannel): void {
	outputChannel = channel
}

/**
 * Get the extension's output channel for logging.
 * Returns `undefined` if called before extension activation.
 */
export function getOutputChannel(): vscode.OutputChannel | undefined {
	return outputChannel
}
