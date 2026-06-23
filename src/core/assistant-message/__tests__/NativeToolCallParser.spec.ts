import { NativeToolCallParser } from "../NativeToolCallParser"

describe("NativeToolCallParser", () => {
	beforeEach(() => {
		NativeToolCallParser.clearAllStreamingToolCalls()
		NativeToolCallParser.clearRawChunkState()
	})

	describe("parseToolCall", () => {
		describe("read_file tool", () => {
			it("should parse minimal single-file read_file args", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/core/task/Task.ts",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.nativeArgs).toBeDefined()
					const nativeArgs = result.nativeArgs as { path: string }
					expect(nativeArgs.path).toBe("src/core/task/Task.ts")
				}
			})

			it("should parse read_file with filePath alias (model hallucination resilience)", () => {
				const toolCall = {
					id: "toolu_filepath_alias",
					name: "read_file" as const,
					arguments: JSON.stringify({
						filePath: "src/filepath-alias.ts",
						offset: 144,
						limit: 50,
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.nativeArgs).toBeDefined()
					const nativeArgs = result.nativeArgs as { path: string; offset?: number; limit?: number }
					expect(nativeArgs.path).toBe("src/filepath-alias.ts")
					expect(nativeArgs.offset).toBe(144)
					expect(nativeArgs.limit).toBe(50)
				}
			})

			it("should prefer path over filePath when both are present", () => {
				const toolCall = {
					id: "toolu_both",
					name: "read_file" as const,
					arguments: JSON.stringify({
						filePath: "src/wrong.ts",
						path: "src/right.ts",
						offset: 1,
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as { path: string }
					expect(nativeArgs.path).toBe("src/right.ts")
				}
			})

			it("should parse read_file with snake_case file_path alias (Claude-Code-style)", () => {
				const toolCall = {
					id: "toolu_file_path_alias",
					name: "read_file" as const,
					arguments: JSON.stringify({
						file_path: "/abs/src/components/WorktreesView.tsx",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as { path: string }
					expect(nativeArgs.path).toBe("/abs/src/components/WorktreesView.tsx")
				}
			})

			it("does not report a missing path when file_path is supplied", () => {
				const toolCall = {
					id: "toolu_file_path_noerror",
					name: "read_file" as const,
					arguments: JSON.stringify({ file_path: "src/a.ts" }),
				}
				const result = NativeToolCallParser.parseToolCall(toolCall)
				// An error result would be an assistant "say" with a missing-field message;
				// a successful parse yields a tool_use with the aliased path.
				expect(result?.type).toBe("tool_use")
			})

			it("should parse list_files with target_directory alias (Cursor-style)", () => {
				const toolCall = {
					id: "toolu_target_dir",
					name: "list_files" as const,
					arguments: JSON.stringify({
						target_directory: "src/components",
						recursive: false,
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as { path: string }
					expect(nativeArgs.path).toBe("src/components")
				}
			})

			it("should prefer path over file_path when both are present", () => {
				const toolCall = {
					id: "toolu_both_snake",
					name: "read_file" as const,
					arguments: JSON.stringify({ file_path: "src/wrong.ts", path: "src/right.ts" }),
				}
				const result = NativeToolCallParser.parseToolCall(toolCall)
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as { path: string }
					expect(nativeArgs.path).toBe("src/right.ts")
				}
			})

			it("should parse slice-mode params", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/core/task/Task.ts",
						mode: "slice",
						offset: 10,
						limit: 20,
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						path: string
						mode?: string
						offset?: number
						limit?: number
					}
					expect(nativeArgs.path).toBe("src/core/task/Task.ts")
					expect(nativeArgs.mode).toBe("slice")
					expect(nativeArgs.offset).toBe(10)
					expect(nativeArgs.limit).toBe(20)
				}
			})

			it("should parse indentation-mode params", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/utils.ts",
						mode: "indentation",
						indentation: {
							anchor_line: 123,
							max_levels: 2,
							include_siblings: true,
							include_header: false,
						},
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						path: string
						mode?: string
						indentation?: {
							anchor_line?: number
							max_levels?: number
							include_siblings?: boolean
							include_header?: boolean
						}
					}
					expect(nativeArgs.path).toBe("src/utils.ts")
					expect(nativeArgs.mode).toBe("indentation")
					expect(nativeArgs.indentation?.anchor_line).toBe(123)
					expect(nativeArgs.indentation?.include_siblings).toBe(true)
					expect(nativeArgs.indentation?.include_header).toBe(false)
				}
			})

			// Legacy format backward compatibility tests
			describe("legacy format backward compatibility", () => {
				it("should parse legacy files array format with single file", () => {
					const toolCall = {
						id: "toolu_legacy_1",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [{ path: "src/legacy/file.ts" }],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as { files: Array<{ path: string }>; _legacyFormat: true }
						expect(nativeArgs._legacyFormat).toBe(true)
						expect(nativeArgs.files).toHaveLength(1)
						expect(nativeArgs.files[0].path).toBe("src/legacy/file.ts")
					}
				})

				it("should parse legacy files array format with multiple files", () => {
					const toolCall = {
						id: "toolu_legacy_2",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [{ path: "src/file1.ts" }, { path: "src/file2.ts" }, { path: "src/file3.ts" }],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as { files: Array<{ path: string }>; _legacyFormat: true }
						expect(nativeArgs.files).toHaveLength(3)
						expect(nativeArgs.files[0].path).toBe("src/file1.ts")
						expect(nativeArgs.files[1].path).toBe("src/file2.ts")
						expect(nativeArgs.files[2].path).toBe("src/file3.ts")
					}
				})

				it("should parse legacy line_ranges as tuples", () => {
					const toolCall = {
						id: "toolu_legacy_3",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: [
										[1, 50],
										[100, 150],
									],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
							_legacyFormat: true
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 1, end: 50 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 100, end: 150 })
					}
				})

				it("should parse legacy line_ranges as objects", () => {
					const toolCall = {
						id: "toolu_legacy_4",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: [
										{ start: 10, end: 20 },
										{ start: 30, end: 40 },
									],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 10, end: 20 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 30, end: 40 })
					}
				})

				it("should parse legacy line_ranges as strings", () => {
					const toolCall = {
						id: "toolu_legacy_5",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: ["1-50", "100-150"],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 1, end: 50 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 100, end: 150 })
					}
				})

				it("should parse double-stringified files array (model quirk)", () => {
					// This tests the real-world case where some models double-stringify the files array
					// e.g., { files: "[{\"path\": \"...\"}]" } instead of { files: [{path: "..."}] }
					const toolCall = {
						id: "toolu_double_stringify",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: JSON.stringify([
								{ path: "src/services/example/service.ts" },
								{ path: "src/services/mcp/McpServerManager.ts" },
							]),
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string }>
							_legacyFormat: true
						}
						expect(nativeArgs._legacyFormat).toBe(true)
						expect(nativeArgs.files).toHaveLength(2)
						expect(nativeArgs.files[0].path).toBe("src/services/example/service.ts")
						expect(nativeArgs.files[1].path).toBe("src/services/mcp/McpServerManager.ts")
					}
				})

				it("should NOT set usedLegacyFormat for new format", () => {
					const toolCall = {
						id: "toolu_new",
						name: "read_file" as const,
						arguments: JSON.stringify({
							path: "src/new/format.ts",
							mode: "slice",
							offset: 1,
							limit: 100,
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBeUndefined()
					}
				})
			})

			describe("vscode-lm XML leak rejection", () => {
				it("rejects apply_diff that leaked its path into the diff (no silent guess + mutate)", () => {
					// Real-world vscode-lm bug: the model emits the path as a leaked
					//   <parameter name="path" string="true">PATH
					// suffix inside `diff` instead of a separate key. We must NOT extract
					// the guessed path and apply the diff to it — reject with feedback.
					const diffContent =
						`<<<<<<< SEARCH\n:start_line:1532\n\told code\n` +
						`=======\n\tnew code\n` +
						`>>>>>>> REPLACE\n` +
						`<parameter name="path" string="true">extensions/shofer/src/core/workflow/WorkflowTask.ts`

					const result = NativeToolCallParser.parseToolCall({
						id: "toolu_xml_leak",
						name: "apply_diff" as const,
						arguments: JSON.stringify({ diff: diffContent }),
					})

					expect(result).toBeNull()
					const err = NativeToolCallParser.consumeLastParseError()
					expect(err).toMatch(/apply_diff/)
					expect(err).toMatch(/path/i)
					expect(err).toMatch(/diff/i)
				})

				it("records the XML-leak rejection for telemetry (audit removal loop)", () => {
					// Detection still leaves a measurable trace — now rejected, not applied.
					NativeToolCallParser.consumeRecoveries() // clear any prior state

					const diffContent =
						`<<<<<<< SEARCH\n:start_line:1\n\told\n=======\n\tnew\n>>>>>>> REPLACE\n` +
						`<parameter name="path" string="true">src/foo.ts`

					const result = NativeToolCallParser.parseToolCall({
						id: "toolu_recovery_telemetry",
						name: "apply_diff" as const,
						arguments: JSON.stringify({ diff: diffContent }),
					})
					expect(result).toBeNull()

					const recoveries = NativeToolCallParser.consumeRecoveries()
					expect(recoveries).toHaveLength(1)
					expect(recoveries[0]).toMatchObject({
						layerId: "apply_diff_xml_leak",
						tool: "apply_diff",
						rejected: true,
					})

					// Draining is idempotent — a clean apply_diff records nothing.
					NativeToolCallParser.parseToolCall({
						id: "toolu_clean",
						name: "apply_diff" as const,
						arguments: JSON.stringify({
							path: "src/bar.ts",
							diff: "<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE",
						}),
					})
					expect(NativeToolCallParser.consumeRecoveries()).toHaveLength(0)
				})

				it("rejects a box-drawing-corrupted XML-leak (U+FF5C prefix) instead of guessing", () => {
					// vscode-lm / deepseek-v4-pro corrupts the "<parameter" prefix by
					// substituting box-drawing Unicode (U+FF5C). Still detected as a leak,
					// so it is rejected rather than silently applied to the guessed path.
					const diffContent =
						`<<<<<<< SEARCH\n:start_line:70\n\told code\n` +
						`=======\n\tnew code\n` +
						`>>>>>>> REPLACE\n` +
						`<\uFF5C\uFF5CDSML\uFF5C\uFF5Cparameter name="path" string="true">extensions/shofer/website/src/data/features.ts`

					const result = NativeToolCallParser.parseToolCall({
						id: "toolu_boxdrawing_xml_leak",
						name: "apply_diff" as const,
						arguments: JSON.stringify({ diff: diffContent }),
					})

					expect(result).toBeNull()
					expect(NativeToolCallParser.consumeLastParseError()).toMatch(/path/i)
				})

				it("should handle apply_diff with normal args (no regression)", () => {
					const toolCall = {
						id: "toolu_normal_diff",
						name: "apply_diff" as const,
						arguments: JSON.stringify({
							path: "src/test.ts",
							diff: "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE",
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						const nativeArgs = result.nativeArgs as { path: string; diff: string }
						expect(nativeArgs.path).toBe("src/test.ts")
						expect(nativeArgs.diff).toBe("<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE")
					}
				})

				it("should handle apply_diff with filePath alias", () => {
					const toolCall = {
						id: "toolu_filepath_alias",
						name: "apply_diff" as const,
						arguments: JSON.stringify({
							filePath: "src/filepath-test.ts",
							diff: "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE",
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						const nativeArgs = result.nativeArgs as { path: string; diff: string }
						expect(nativeArgs.path).toBe("src/filepath-test.ts")
					}
				})

				it("should prefer path over filePath when both present", () => {
					const toolCall = {
						id: "toolu_both",
						name: "apply_diff" as const,
						arguments: JSON.stringify({
							path: "src/right.ts",
							filePath: "src/wrong.ts",
							diff: "test",
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						const nativeArgs = result.nativeArgs as { path: string; diff: string }
						expect(nativeArgs.path).toBe("src/right.ts")
					}
				})

				it("should return null when both path and diff are missing and no XML leak", () => {
					const toolCall = {
						id: "toolu_no_args",
						name: "apply_diff" as const,
						arguments: JSON.stringify({}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).toBeNull()
				})

				it("should return null when diff is missing and path is present", () => {
					const toolCall = {
						id: "toolu_no_diff",
						name: "apply_diff" as const,
						arguments: JSON.stringify({ path: "src/test.ts" }),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).toBeNull()
				})

				it("should NOT false-recover path when parameter-like text appears before > REPLACE boundary", () => {
					// The diff SEARCH block legitimately contains a line that looks
					// like an XML-leak path suffix, but it appears BEFORE the
					// ">>>>>>> REPLACE" boundary, so it is real diff data, not a
					// model-side parameter leak.  The "$" end-of-string anchor in
					// the regex must reject this.
					const diffContent =
						`<<<<<<< SEARCH\n` +
						`<parameter name="path" string="true">legit/doc.md\n` +
						`-------\n` +
						`unchanged\n` +
						`>>>>>>> REPLACE`

					const toolCall = {
						id: "toolu_false_positive_guard",
						name: "apply_diff" as const,
						arguments: JSON.stringify({ diff: diffContent }),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).toBeNull()
				})
			})
		})
	})

	describe("processStreamingChunk", () => {
		describe("read_file tool", () => {
			it("should emit a partial ToolUse with nativeArgs.path during streaming", () => {
				const id = "toolu_streaming_123"
				NativeToolCallParser.startStreamingToolCall(id, "read_file")

				// Simulate streaming chunks
				const fullArgs = JSON.stringify({ path: "src/test.ts" })

				// Process the complete args as a single chunk for simplicity
				const result = NativeToolCallParser.processStreamingChunk(id, fullArgs)

				expect(result).not.toBeNull()
				expect(result?.nativeArgs).toBeDefined()
				const nativeArgs = result?.nativeArgs as { path: string }
				expect(nativeArgs.path).toBe("src/test.ts")
			})
		})
	})

	describe("finalizeStreamingToolCall", () => {
		describe("read_file tool", () => {
			it("should parse read_file args on finalize", () => {
				const id = "toolu_finalize_123"
				NativeToolCallParser.startStreamingToolCall(id, "read_file")

				// Add the complete arguments
				NativeToolCallParser.processStreamingChunk(
					id,
					JSON.stringify({
						path: "finalized.ts",
						mode: "slice",
						offset: 1,
						limit: 10,
					}),
				)

				const result = NativeToolCallParser.finalizeStreamingToolCall(id)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as { path: string; offset?: number; limit?: number }
					expect(nativeArgs.path).toBe("finalized.ts")
					expect(nativeArgs.offset).toBe(1)
					expect(nativeArgs.limit).toBe(10)
				}
			})

			it("should return null when required arg is missing (guard-UNblock regression test)", () => {
				// REGRESSION: The bug in docs/tool-call-failures.md §B/C was that
				// finalizeStreamingToolCall() returns null (correct), but
				// createPartialToolUse had already populated a stale partial
				// nativeArgs that Task.ts's null-branch did NOT clear, so the
				// guard (isKnownTool && !block.nativeArgs) never fired.
				//
				// This test locks in the parser-level contract: finalize with
				// incomplete args MUST return null, so Task.ts's null-branch
				// (which now clears nativeArgs) is reached.
				const id = "toolu_incomplete_002"
				NativeToolCallParser.startStreamingToolCall(id, "read_file")

				// Optimistic partial: path was streamed, populate a partial nativeArgs
				NativeToolCallParser.processStreamingChunk(id, JSON.stringify({ path: "src/incomplete.ts" }))

				// Now feed an overwriting chunk that is valid JSON but is MISSING
				// the required 'path' field -- the final parse must fail.
				NativeToolCallParser.processStreamingChunk(id, JSON.stringify({ mode: "slice", offset: 10 }))

				const result = NativeToolCallParser.finalizeStreamingToolCall(id)

				// Parser contract: null on incomplete/malformed final args.
				expect(result).toBeNull()
			})
		})

		describe("new_task prompt/description aliasing (Anthropic/Claude naming conventions)", () => {
			it("should map prompt → message and description → title", () => {
				const toolCall = {
					id: "toolu_newtask_aliases",
					name: "new_task" as const,
					arguments: JSON.stringify({
						mode: "code",
						prompt: "Implement the feature",
						description: "Feature implementation task",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						mode: string
						message: string
						title?: string
					}
					expect(nativeArgs.mode).toBe("code")
					expect(nativeArgs.message).toBe("Implement the feature")
					expect(nativeArgs.title).toBe("Feature implementation task")
				}
			})

			it("should prefer canonical message over prompt alias (no clobber)", () => {
				const toolCall = {
					id: "toolu_newtask_canonical_wins",
					name: "new_task" as const,
					arguments: JSON.stringify({
						mode: "code",
						message: "Canonical instructions",
						prompt: "Alias instructions (should not win)",
						description: "Alias title (should not win)",
						title: "Canonical title",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						mode: string
						message: string
						title?: string
					}
					expect(nativeArgs.message).toBe("Canonical instructions")
					expect(nativeArgs.title).toBe("Canonical title")
				}
			})

			it("prompt → message aliasing is harmless for generate_image (regression guard)", () => {
				// generate_image reads args.prompt directly and never looks at args.message.
				// The aliasing sets args.message from args.prompt but this must NOT corrupt generate_image.
				const toolCall = {
					id: "toolu_genimg",
					name: "generate_image" as const,
					arguments: JSON.stringify({
						prompt: "a sunset over mountains",
						path: "out/sunset.png",
						image: null,
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						prompt: string
						path: string
						image: unknown
					}
					expect(nativeArgs.prompt).toBe("a sunset over mountains")
					expect(nativeArgs.path).toBe("out/sunset.png")
				}
			})

			it("description-only without prompt still fails (description is NOT a message fallback)", () => {
				// description → title only. Without prompt or message, the call must still be rejected.
				const toolCall = {
					id: "toolu_newtask_desc_only",
					name: "new_task" as const,
					arguments: JSON.stringify({
						mode: "code",
						description: "Just a short summary, no instructions",
						todos: "[x] done",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				// Must reject: no message and no prompt, so message is genuinely missing.
				expect(result).toBeNull()
			})
		})

		describe("cross-assistant tool alias resolution", () => {
			it("resolves search_content name to grep_search nativeArgs", () => {
				const toolCall = {
					id: "toolu_search_content",
					name: "search_content" as const,
					arguments: JSON.stringify({
						path: "/src",
						query: "test",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall as any)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.name).toBe("grep_search")
					expect(result.originalName).toBe("search_content")
					expect(result.nativeArgs).toBeDefined()
					const nativeArgs = result.nativeArgs as { path: string; query: string }
					expect(nativeArgs.path).toBe("/src")
					expect(nativeArgs.query).toBe("test")
				}
			})

			it("resolves search_content + directory arg via PATH_ARG_ALIASES", () => {
				const toolCall = {
					id: "toolu_search_content_dir",
					name: "search_content" as const,
					arguments: JSON.stringify({
						directory: "/src",
						query: "test",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall as any)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.name).toBe("grep_search")
					expect(result.nativeArgs).toBeDefined()
					const nativeArgs = result.nativeArgs as { path: string; query: string }
					expect(nativeArgs.path).toBe("/src")
					expect(nativeArgs.query).toBe("test")
				}
			})

			it("resolves bash alias to execute_command", () => {
				const toolCall = {
					id: "toolu_bash_alias",
					name: "bash" as const,
					arguments: JSON.stringify({
						command: "echo hello",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall as any)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.name).toBe("execute_command")
					expect(result.originalName).toBe("bash")
					expect(result.nativeArgs).toBeDefined()
					const nativeArgs = result.nativeArgs as { command: string }
					expect(nativeArgs.command).toBe("echo hello")
				}
			})

			it("resolves search_file alias to find_files, anchoring the filename pattern under the directory (recursive)", () => {
				// Claude Code's search_file takes a directory + a filename pattern and
				// searches recursively. find_files runs the pattern through
				// vscode.RelativePattern, where a bare `*.ts` matches the root only —
				// so the directory must be folded into a recursive glob to preserve intent.
				const toolCall = {
					id: "toolu_search_file_find_files",
					name: "search_file" as const,
					arguments: JSON.stringify({
						path: "src",
						pattern: "*.ts",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall as any)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.name).toBe("find_files")
					expect(result.originalName).toBe("search_file")
					expect(result.nativeArgs).toBeDefined()
					const nativeArgs = result.nativeArgs as { pattern: string }
					// Directory `src` + filename `*.ts` → recursive glob under src.
					expect(nativeArgs.pattern).toBe("src/**/*.ts")
				}
			})

			it("leaves find_files pattern unchanged when no directory is supplied", () => {
				const toolCall = {
					id: "toolu_find_files_no_dir",
					name: "find_files" as const,
					arguments: JSON.stringify({ pattern: "**/*.ts" }),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall as any)

				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.name).toBe("find_files")
					expect((result.nativeArgs as { pattern: string }).pattern).toBe("**/*.ts")
				}
			})

			it("does not double-anchor when the directory and an already-recursive pattern are combined", () => {
				const toolCall = {
					id: "toolu_search_file_recursive",
					name: "search_file" as const,
					arguments: JSON.stringify({ path: "src/", pattern: "**/*.tsx" }),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall as any)

				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.name).toBe("find_files")
					// trailing slash stripped; `**/…` pattern prefixed (not `**/**`).
					expect((result.nativeArgs as { pattern: string }).pattern).toBe("src/**/*.tsx")
				}
			})

			it("returns null and sets lastParseError for totally unknown tool (no alias)", () => {
				const toolCall = {
					id: "toolu_truly_unknown",
					name: "nonexistent_tool_xyz",
					arguments: JSON.stringify({
						path: "src",
					}),
				}

				NativeToolCallParser.consumeLastParseError()

				const result = NativeToolCallParser.parseToolCall(toolCall as any)

				expect(result).toBeNull()
				const parseError = NativeToolCallParser.consumeLastParseError()
				expect(parseError).not.toBeNull()
				expect(parseError).toContain("Unknown tool")
				expect(parseError).toContain("nonexistent_tool_xyz")
				// Levenshtein suggestion: the closest match should be included
				expect(parseError).toMatch(/Did you mean '[a-z_]+'\?/)
				// Available tools list should be included
				expect(parseError).toContain("Available tools:")
				expect(parseError).toContain("grep_search")
			})
		})
	})
})
