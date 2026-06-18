import { McpHub } from "../../../services/mcp/McpHub"

/**
 * @param groups When provided (workflow agents with a `.slang` `tools:`
 *   restriction), the capability prose is gated to only the groups the agent
 *   actually has — so e.g. a `[questions]`-only coordinator isn't told it can
 *   read/write files or run commands (which would invite it to hallucinate
 *   tools that aren't in its catalog). When undefined, the full prose is
 *   rendered unchanged (normal tasks).
 */
export function getCapabilitiesSection(cwd: string, mcpHub?: McpHub, groups?: Set<string>): string {
	// Unrestricted path: byte-identical to the original prose.
	if (groups === undefined) {
		return `====

CAPABILITIES

- You have access to tools that let you execute CLI commands on the user's computer, list files, view source code definitions, regex search, read and write files, and ask follow-up questions. These tools help you effectively accomplish a wide range of tasks, such as writing code, making edits or improvements to existing files, understanding the current state of a project, performing system operations, and much more.
- When the user initially gives you a task, a recursive list of all filepaths in the current workspace directory ('${cwd}') will be included in environment_details. This provides an overview of the project's file structure, offering key insights into the project from directory/file names (how developers conceptualize and organize their code) and file extensions (the language used). This can also guide decision-making on which files to explore further. If you need to further explore directories such as outside the current workspace directory, you can use the list_files tool. If you pass 'true' for the recursive parameter, it will list files recursively. Otherwise, it will list files at the top level, which is better suited for generic directories where you don't necessarily need the nested structure, like the Desktop.
- You can use the execute_command tool to run commands on the user's computer whenever you feel it can help accomplish the user's task. When you need to execute a CLI command, you must provide a clear explanation of what the command does. Prefer to execute complex CLI commands over creating executable scripts, since they are more flexible and easier to run. Interactive and long-running commands are allowed, since the commands are run in the user's VSCode terminal. The user may keep commands running in the background and you will be kept updated on their status along the way. Each command you execute is run in a new terminal instance.${
			mcpHub
				? `
- You have access to MCP servers that may provide additional tools and resources. Each server may provide different capabilities that you can use to accomplish tasks more effectively.
`
				: ""
		}`
	}

	// Restricted path: describe only what the agent's tool groups allow.
	const canRead = groups.has("read")
	const canWrite = groups.has("write")
	const canExecute = groups.has("execute")

	const abilities: string[] = []
	if (canExecute) abilities.push("execute CLI commands on the user's computer")
	if (canRead) abilities.push("list files, view source code definitions, and regex search")
	if (canRead && canWrite) abilities.push("read and write files")
	else if (canWrite) abilities.push("write files")
	else if (canRead) abilities.push("read files")
	abilities.push("ask follow-up questions")

	const purposes = ["understanding the current state of a project"]
	if (canWrite) purposes.unshift("writing code, making edits or improvements to existing files")
	if (canExecute) purposes.push("performing system operations")

	const lines: string[] = [
		`- You have access to tools that let you ${joinList(abilities)}. These tools help you accomplish tasks such as ${joinList(purposes)}, and more.`,
	]

	// The recursive workspace file listing is shown in environment_details
	// regardless of which tools the agent has; only the `list_files` follow-up
	// hint depends on the read group.
	lines.push(
		`- When the user initially gives you a task, a recursive list of all filepaths in the current workspace directory ('${cwd}') will be included in environment_details. This provides an overview of the project's file structure from directory/file names and extensions, which can guide your decisions.${
			canRead
				? " To explore directories further (including outside the workspace), use the list_files tool; pass 'true' for the recursive parameter to list recursively."
				: ""
		}`,
	)

	if (canExecute) {
		lines.push(
			`- You can use the execute_command tool to run commands on the user's computer whenever it can help accomplish the task. Provide a clear explanation of what each command does. Prefer complex CLI commands over creating scripts. Interactive and long-running commands are allowed (run in the user's VSCode terminal); each command runs in a new terminal instance.`,
		)
	}

	if (mcpHub) {
		lines.push(
			`- You have access to MCP servers that may provide additional tools and resources to accomplish tasks more effectively.`,
		)
	}

	if (!canRead && !canWrite && !canExecute) {
		lines.push(
			`- You are a coordination agent: you do NOT read, write, or execute — you direct other agents and complete your assigned step. Do not attempt to call file or command tools; they are not available to you.`,
		)
	}

	return `====

CAPABILITIES

${lines.join("\n")}`
}

/** Join a list with commas and a trailing "and" (Oxford-style, no serial comma issues). */
function joinList(items: string[]): string {
	if (items.length <= 1) return items[0] ?? ""
	if (items.length === 2) return `${items[0]} and ${items[1]}`
	return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`
}
