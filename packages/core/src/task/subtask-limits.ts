/**
 * Leaf constants for subtask result/timeout limits.
 *
 * Kept in a dependency-free module so it can be imported by both the
 * Task-cluster tools that still live in `src/` (e.g. NewTaskTool) and the
 * native-tool descriptions that live in `@shofer/core` without pulling in the
 * Task SCC.
 */

/** Hard safety cap for subtask completion result length, in characters. */
export const MAX_SUBTASK_RESULT_LENGTH = 100000
