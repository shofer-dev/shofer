/**
 * Host-agnostic registry for the Category II `LiveMemoryManager` (VS Code `src`).
 *
 * Mirrors the {@link ../mcp/mcp-hub-factory} seam: the concrete manager needs a
 * `vscode.ExtensionContext` (and reaches into `ContextProxy` /
 * `ProviderSettingsManager`), so the portable core must not import it. Core-resident
 * callers — `AskLiveMemoryTool`, `FileContextTracker`, the `live-memory` prompt
 * section — reach the manager through this registered accessor instead.
 *
 * The VS Code extension registers an accessor at activation (wrapping the manager's
 * static `getInstance` / `getAllInstances`). In headless / non-VS-Code hosts the
 * accessor stays unset and the getter returns `undefined`, so Live Memory is simply
 * off (the feature degrades rather than failing).
 */
import type { LiveMemoryState, QuestionResult } from "@shofer/types"

/**
 * The narrow slice of the concrete `LiveMemoryManager` the portable core reads.
 * Captures ONLY the members the core-resident callers use, so the core never
 * depends on the VS Code-coupled class.
 */
export interface LiveMemoryManagerLike {
	readonly state: LiveMemoryState
	readonly stateMessage: string
	readonly isLiveMemoryAvailable: boolean
	readonly modelId: string
	readonly provider: string
	readonly contextFiles: string[]
	readonly estimatedTokenCount: number
	readonly maxContextTokens: number
	readonly isContextNearlyFull: boolean
	askQuestion(
		question: string,
		contextFiles?: string[],
		opts?: { timeoutMs?: number; softTimeoutSec?: number; softResultLength?: number },
	): Promise<QuestionResult>
	notifyFileModified(filePath: string): void
}

/**
 * The accessor the front-end registers — wraps the manager's static singleton
 * lookup. `getInstance` mirrors `LiveMemoryManager.getInstance(context, workspacePath)`
 * (the opaque `context` is cast back to `vscode.ExtensionContext` in the adapter);
 * `getAllInstances` mirrors the static of the same name used by `FileContextTracker`.
 */
export interface LiveMemoryManagerAccessor {
	getInstance(context: unknown, workspacePath: string): LiveMemoryManagerLike | undefined
	getAllInstances(): LiveMemoryManagerLike[]
}

let accessor: LiveMemoryManagerAccessor | undefined

/** Registers the host accessor used to reach the Live Memory manager singleton(s). */
export function setLiveMemoryManagerAccessor(a: LiveMemoryManagerAccessor): void {
	accessor = a
}

/** Returns the registered Live Memory accessor, or `undefined` when unset (headless = feature off). */
export function getLiveMemoryManagerAccessor(): LiveMemoryManagerAccessor | undefined {
	return accessor
}
