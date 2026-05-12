import type OpenAI from "openai"

const WORKTREE_DESCRIPTION = `Manage git worktrees for parallel task execution. Creates worktrees under .roo/worktrees/ by default. The orchestrator uses this to create isolated worktrees, spawn subtasks on them, merge results, and clean up — all without execute_command access.

Parameters:
- subcommand: (required) One of: create, list, merge, destroy, status
- path: (create/destroy/status) Worktree directory path (absolute or relative to workspace root)
- branch: (create, optional) Branch name for the new worktree. Defaults to worktree/roo-<random5>
- base_branch: (create, optional) Base branch to create from. Defaults to the current branch (main/master)
- force: (destroy, optional) Force removal even if the branch hasn't been merged. Default false.

Subcommand behaviors:
- create: Runs git worktree add <path> <branch>, copies .worktreeinclude files, adds .roo/worktrees/ to .gitignore if needed
- list: Lists all worktrees with Roo Code annotation
- merge: Merges a worktree branch into the current branch with --no-ff, reports conflicts
- destroy: Removes worktree and deletes branch. Refuses unmerged branches unless force=true
- status: Reports ahead/behind counts, uncommitted changes, merge readiness`

const SUBCOMMAND_DESCRIPTION = `One of: create, list, merge, destroy, status`

const PATH_DESCRIPTION = `Worktree directory path (absolute or relative to workspace root)`

const BRANCH_DESCRIPTION = `Branch name for the new worktree. Defaults to worktree/roo-<random5>`

const BASE_BRANCH_DESCRIPTION = `Base branch to create from. Defaults to the current branch (main/master)`

const TARGET_BRANCH_DESCRIPTION = `(merge only) Branch into which the worktree branch should be merged. Defaults to the detected base branch (main/master). The merge refuses if the main worktree's HEAD is not on this branch.`

const FORCE_DESCRIPTION = `Force removal even if the branch hasn't been merged. Default false.`

export default {
	type: "function" as const,
	function: {
		name: "worktree",
		description: WORKTREE_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object" as const,
			properties: {
				subcommand: {
					type: "string" as const,
					description: SUBCOMMAND_DESCRIPTION,
					enum: ["create", "list", "merge", "destroy", "status"],
				},
				path: {
					type: ["string", "null"] as const,
					description: PATH_DESCRIPTION,
				},
				branch: {
					type: ["string", "null"] as const,
					description: BRANCH_DESCRIPTION,
				},
				base_branch: {
					type: ["string", "null"] as const,
					description: BASE_BRANCH_DESCRIPTION,
				},
				target_branch: {
					type: ["string", "null"] as const,
					description: TARGET_BRANCH_DESCRIPTION,
				},
				force: {
					type: ["boolean", "null"] as const,
					description: FORCE_DESCRIPTION,
				},
			},
			// OpenAI strict mode requires every property to be listed in `required`;
			// optional parameters use a nullable type and the model must explicitly
			// pass null when omitting them.
			required: ["subcommand", "path", "branch", "base_branch", "target_branch", "force"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
