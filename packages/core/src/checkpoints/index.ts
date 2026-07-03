export type { CheckpointServiceOptions } from "./types.js"

export { RepoPerTaskCheckpointService } from "./RepoPerTaskCheckpointService.js"

export { ShadowCheckpointService } from "./ShadowCheckpointService.js"

// Task-cluster Chunk C: the host-agnostic checkpoint orchestration wrapper
// (getCheckpointService / checkpointSave / checkpointRestore / checkpointDiff)
// relocated from the VS Code `src` tree.
export * from "./orchestrator.js"
