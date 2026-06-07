/**
 * Shofer CLI Client Library
 *
 * Public API surface for external consumers that want to use the CLI's
 * ExtensionClient + StateStore + MessageProcessor stack as a reusable
 * headless SDK for driving Shofer programmatically.
 *
 * Usage:
 * ```typescript
 * import { ExtensionClient, StateStore, createClient, type ClientEventMap } from '@shofer/cli/client'
 * ```
 */

// Core client
export { ExtensionClient, createClient, createMockClient } from "./extension-client.js"
export type { ExtensionClientConfig } from "./extension-client.js"

// State management
export { StateStore } from "./state-store.js"

// Message processing
export { MessageProcessor, parseExtensionMessage } from "./message-processor.js"
export type { MessageProcessorOptions } from "./message-processor.js"

// Event system
export {
	TypedEventEmitter,
	Observable,
	isSignificantStateChange,
	transitionedToWaiting,
	transitionedToRunning,
	streamingStarted,
	streamingEnded,
	taskCompleted,
} from "./events.js"
export type {
	ClientEventMap,
	AgentStateChangeEvent,
	WaitingForInputEvent,
	TaskCompletedEvent,
	ModeChangedEvent,
	Observer,
	Unsubscribe,
} from "./events.js"

// Agent state
export { AgentLoopState } from "./agent-state.js"
export type { AgentStateInfo } from "./agent-state.js"
