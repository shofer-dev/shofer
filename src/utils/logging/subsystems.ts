/**
 * @fileoverview Per-subsystem logger instances.
 *
 * Each export is a scoped `ILogger` tagged with a `ctx` identifier so
 * every line in the output channel is prefixed with its origin.  Create
 * additional subsystem loggers here as the codebase grows — the pattern is:
 *
 *   export const myLogger = getLogger().child({ ctx: "MySubsystem" })
 *
 * Usage in subsystem code:
 *
 *   import { myLogger } from "../../utils/logging/subsystems"
 *   myLogger.info("initialized", { key: value })
 */

import { getLogger } from "./index"

/** Core task engine (Task, BaseTool, condense, etc.) */
export const taskLog = getLogger().child({ ctx: "Task" })

/** Webview / provider / IPC layer */
export const webviewLog = getLogger().child({ ctx: "Webview" })

/** Git index, file watcher, git history */
export const gitLog = getLogger().child({ ctx: "Git" })

/** Code index (RAG) and tree-sitter */
export const codeIndexLog = getLogger().child({ ctx: "CodeIndex" })

/** Assistant agent subsystem */
export const assistantAgentLog = getLogger().child({ ctx: "AssistantAgent" })

/** MCP servers and transport */
export const mcpLog = getLogger().child({ ctx: "MCP" })

/** Checkpoints / shadow git */
export const checkpointLog = getLogger().child({ ctx: "Checkpoints" })

/** API providers (Anthropic, OpenAI, Bedrock, etc.) */
export const apiLog = getLogger().child({ ctx: "API" })

/** File I/O utilities (safeWriteJson, storage, etc.) */
export const fsLog = getLogger().child({ ctx: "FS" })

/** Configuration, ContextProxy, settings migration */
export const configLog = getLogger().child({ ctx: "Config" })

/** Skills subsystem */
export const skillsLog = getLogger().child({ ctx: "Skills" })

/** Marketplace / installer */
export const marketplaceLog = getLogger().child({ ctx: "Marketplace" })

/** Metrics / Prometheus */
export const metricsLog = getLogger().child({ ctx: "Metrics" })

/** Workflow engine (.slang) */
export const workflowLog = getLogger().child({ ctx: "Workflow" })

/** i18n / translations */
export const i18nLog = getLogger().child({ ctx: "I18n" })

/** General utilities (countTokens, path, perf, etc.) */

/** Scroll lifecycle (useScrollLifecycle webview-to-host diagnostic forwarding) */
export const scrollLog = getLogger().child({ ctx: "Scroll" })
export const utilLog = getLogger().child({ ctx: "Utils" })
