import { toolNames, type ToolName } from "@shofer/types"

import { resolveToolAlias } from "../../tools/tool-aliases.js"
import { NativeToolCallParser } from "../NativeToolCallParser.js"

/**
 * The Native Tool Parser Cases Rule, enforced as a table rather than as prose.
 *
 * AGENTS.md: "A new native tool MUST add cases in **both** switches inside
 * NativeToolCallParser — createPartialToolUse() (partial args) AND
 * parseToolCall() (complete args). Registering the tool in toolNames,
 * TOOL_GROUPS, the schema, the handler and the router is NOT enough: with no
 * parser case, `nativeArgs` is undefined, the dispatcher guard rejects the call
 * with 'missing nativeArgs', and execute() is never reached — surfacing as a
 * generic 'Provider Error / API Request Failed' with zero handler logs."
 *
 * That failure mode is invisible to every other test in this package, because
 * each tool's own suite calls `execute()` with hand-written args and never goes
 * through the parser. So the table below carries ONE schema-valid argument set
 * per `ToolName`, and the suite drives it down both paths. A tool added to
 * `toolNames` without a table row fails the completeness test; a tool with a row
 * but no parser case fails on `nativeArgs`.
 *
 * `custom_tool` is deliberately excluded: it is the placeholder name for
 * registry-resolved custom tools, not a native tool with a parser case — the
 * switch's `default` arm serves it, gated on `customToolRegistry.has()`.
 */

/** Tools reached only through the registry/default arm, not a parser case. */
const NOT_A_NATIVE_PARSER_CASE: ReadonlySet<string> = new Set(["custom_tool"])

/** One schema-valid argument object per native tool. */
const VALID_ARGS: Record<string, Record<string, unknown>> = {
	execute_command: { command: "echo hi", cwd: "/tmp" },
	read_file: { path: "src/a.ts", offset: 1, limit: 20 },
	read_command_output: { artifact_id: "art-1" },
	read_output_channel: { channel: "Shofer", tail: true },
	write_to_file: { path: "src/a.ts", content: "hello" },
	apply_diff: { path: "src/a.ts", diff: "<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE" },
	edit: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
	search_and_replace: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
	search_replace: { file_path: "src/a.ts", old_string: "a", new_string: "b" },
	edit_file: { file_path: "src/a.ts", old_string: "a", new_string: "b", expected_replacements: 1 },
	apply_patch: { patch: "*** Begin Patch\n*** End Patch" },
	grep_search: { path: "src", query: "foo" },
	list_files: { path: "src", recursive: true },
	use_mcp_tool: { server_name: "srv", tool_name: "t", arguments: { a: 1 } },
	access_mcp_resource: { server_name: "srv", uri: "res://x" },
	ask_followup_question: { question: "Which one?", follow_up: ["a", "b"] },
	attempt_completion: { result: "done", rating: "good" },
	switch_mode: { mode_slug: "code", reason: "because" },
	new_task: { mode: "code", message: "do it" },
	update_todo_list: { todos: "[ ] one" },
	run_slash_command: { command: "test", args: "-v" },
	skills: { skill: "verify-mermaid" },
	generate_image: { prompt: "a cat", path: "out.png" },
	create_directory: { path: "src/new" },
	create_new_workspace: { path: "/tmp/ws", name: "ws" },
	file: { subcommand: "rm", path: "src/a.ts" },
	fetch_web_page: { urls: ["https://example.com"] },
	find_files: { pattern: "*.ts" },
	get_errors: { filePaths: ["src/a.ts"] },
	get_project_setup_info: {},
	insert_edit: { path: "src/a.ts", line: 3, text: "x" },
	list_code_usages: { path: "src/a.ts", line: 3, column: 2 },
	read_project_structure: { maxDepth: 2 },
	rename_symbol: { path: "src/a.ts", line: 3, column: 2, newName: "y" },
	view_image: { path: "img.png" },
	lsp_search: { query: "Task" },
	set_task_title: { title: "A title" },
	give_feedback: { feedback: "nice" },
	check_task_status: { task_id: "t-1" },
	list_background_tasks: { scope: "children" },
	cancel_tasks: { task_ids: ["t-1"] },
	sed: { path: "src/a.ts", pattern: "a", replacement: "b" },
	call_mcp_tool_async: { server_name: "srv", tool_name: "t" },
	check_mcp_call_status: { call_id: "c-1" },
	wait_for_mcp_call: { call_ids: ["c-1"] },
	send_message: { to: "t-2", body: "hi" },
	reply: { replies: [{ message_id: "m-1", body: "ok" }] },
	wait: { timeout_sec: 5 },
	describe_tools: { names: ["read_file"] },
}

const NATIVE_TOOLS = toolNames.filter((n) => !NOT_A_NATIVE_PARSER_CASE.has(n))

describe("NativeToolCallParser — every native tool has both parser cases", () => {
	afterEach(() => {
		NativeToolCallParser.consumeLastParseError()
		NativeToolCallParser.consumeRecoveries()
	})

	it("covers every name in `toolNames` with a fixture", () => {
		const missing = NATIVE_TOOLS.filter((n) => VALID_ARGS[n] === undefined)
		expect(missing, `add a VALID_ARGS row for: ${missing.join(", ")}`).toEqual([])
	})

	describe.each(NATIVE_TOOLS)("%s", (name) => {
		const args = VALID_ARGS[name]!
		// A name in `toolNames` may still be an alias of another (search_and_replace
		// → edit); the parser resolves it and the ToolUse carries the CANONICAL name,
		// with the model's spelling preserved on `originalName` for API history.
		const canonical = resolveToolAlias(name)

		it("parseToolCall() builds typed nativeArgs from complete arguments", () => {
			const result = NativeToolCallParser.parseToolCall({
				id: `call-${name}`,
				name: name as ToolName,
				arguments: JSON.stringify(args),
			})

			expect(result, `parseToolCall returned null for ${name}`).not.toBeNull()
			expect(result!.name).toBe(canonical)
			if (canonical !== name) {
				expect((result as { originalName?: string }).originalName).toBe(name)
			}
			expect(result!.partial).toBe(false)
			// The dispatcher rejects a call whose nativeArgs is undefined; that
			// rejection is the "missing parser case" symptom this rule exists for.
			expect((result as { nativeArgs?: unknown }).nativeArgs, `${name} produced no nativeArgs`).toBeDefined()
		})

		it("createPartialToolUse() renders the same call while it is still streaming", () => {
			const parser = new NativeToolCallParser()
			const json = JSON.stringify(args)
			parser.startStreamingToolCall(`call-${name}`, name)

			// Split mid-JSON so the partial-json parser sees a truncated document,
			// which is exactly what a provider's argument deltas look like.
			const cut = Math.max(1, Math.floor(json.length / 2))
			const partial = parser.processStreamingChunk(`call-${name}`, json.slice(0, cut))

			// A partial render is best-effort (an empty prefix legitimately yields
			// nothing), but when it renders it must be marked partial and named.
			if (partial) {
				expect(partial.partial).toBe(true)
				expect(partial.name).toBe(canonical)
			}

			const final = parser.processStreamingChunk(`call-${name}`, json.slice(cut))
			expect(final, `no partial ToolUse for ${name} once the arguments are whole`).not.toBeNull()
			expect(final!.partial).toBe(true)
			expect(final!.name).toBe(canonical)

			// Finalizing the same stream yields the complete, typed call and
			// releases the per-stream state.
			const complete = parser.finalizeStreamingToolCall(`call-${name}`)
			expect(complete).not.toBeNull()
			expect(complete!.partial).toBe(false)
			expect(parser.hasActiveStreamingToolCalls()).toBe(false)
		})
	})
})
