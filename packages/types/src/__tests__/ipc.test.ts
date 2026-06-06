import { TaskCommandName, taskCommandSchema } from "../ipc.js"

describe("IPC Types", () => {
	describe("TaskCommandName", () => {
		it("should include ResumeTask command", () => {
			expect(TaskCommandName.ResumeTask).toBe("ResumeTask")
		})

		it("should include DeleteQueuedMessage command", () => {
			expect(TaskCommandName.DeleteQueuedMessage).toBe("DeleteQueuedMessage")
		})

		it("should have all expected task commands", () => {
			const expectedCommands = [
				"StartNewTask",
				"CancelTask",
				"CloseTask",
				"ResumeTask",
				"SendMessage",
				"DeleteQueuedMessage",
				"ShowTaskWithId",
				"RenameTask",
				"ArchiveTask",
				"UnarchiveTask",
				"PinTask",
				"UnpinTask",
				"DeleteTask",
				"GetTaskMarkdownExport",
				"GetTaskJsonExport",
				"ExportConfiguration",
				"ImportConfiguration",
			]
			const actualCommands = Object.values(TaskCommandName)

			expectedCommands.forEach((command) => {
				expect(actualCommands).toContain(command)
			})
		})

		describe("Error Handling", () => {
			it("should handle ResumeTask command gracefully when task not found", () => {
				// This test verifies the schema validation - the actual error handling
				// for invalid task IDs is tested at the API level, not the schema level
				const resumeTaskCommand = {
					commandName: TaskCommandName.ResumeTask,
					data: "non-existent-task-id",
				}

				const result = taskCommandSchema.safeParse(resumeTaskCommand)
				expect(result.success).toBe(true)

				if (result.success && result.data.commandName === TaskCommandName.ResumeTask) {
					expect(result.data.commandName).toBe("ResumeTask")
					expect(result.data.data).toBe("non-existent-task-id")
				}
			})
		})
	})

	describe("taskCommandSchema", () => {
		it("should validate ResumeTask command with taskId", () => {
			const resumeTaskCommand = {
				commandName: TaskCommandName.ResumeTask,
				data: "task-123",
			}

			const result = taskCommandSchema.safeParse(resumeTaskCommand)
			expect(result.success).toBe(true)

			if (result.success && result.data.commandName === TaskCommandName.ResumeTask) {
				expect(result.data.commandName).toBe("ResumeTask")
				expect(result.data.data).toBe("task-123")
			}
		})

		it("should reject ResumeTask command with invalid data", () => {
			const invalidCommand = {
				commandName: TaskCommandName.ResumeTask,
				data: 123, // Should be string
			}

			const result = taskCommandSchema.safeParse(invalidCommand)
			expect(result.success).toBe(false)
		})

		it("should reject ResumeTask command without data", () => {
			const invalidCommand = {
				commandName: TaskCommandName.ResumeTask,
				// Missing data field
			}

			const result = taskCommandSchema.safeParse(invalidCommand)
			expect(result.success).toBe(false)
		})

		it("should validate DeleteQueuedMessage command with messageId", () => {
			const command = {
				commandName: TaskCommandName.DeleteQueuedMessage,
				data: "msg-abc-123",
			}

			const result = taskCommandSchema.safeParse(command)
			expect(result.success).toBe(true)

			if (result.success && result.data.commandName === TaskCommandName.DeleteQueuedMessage) {
				expect(result.data.commandName).toBe("DeleteQueuedMessage")
				expect(result.data.data).toBe("msg-abc-123")
			}
		})

		it("should reject DeleteQueuedMessage command with invalid data", () => {
			const invalidCommand = {
				commandName: TaskCommandName.DeleteQueuedMessage,
				data: 123, // Should be string
			}

			const result = taskCommandSchema.safeParse(invalidCommand)
			expect(result.success).toBe(false)
		})

		it("should reject DeleteQueuedMessage command without data", () => {
			const invalidCommand = {
				commandName: TaskCommandName.DeleteQueuedMessage,
				// Missing data field
			}

			const result = taskCommandSchema.safeParse(invalidCommand)
			expect(result.success).toBe(false)
		})

		it("should validate ShowTaskWithId command", () => {
			const result = taskCommandSchema.safeParse({
				commandName: TaskCommandName.ShowTaskWithId,
				data: { taskId: "task-123" },
			})
			expect(result.success).toBe(true)
			if (result.success && result.data.commandName === TaskCommandName.ShowTaskWithId) {
				expect(result.data.data.taskId).toBe("task-123")
			}
		})

		it("should validate ShowTaskWithId command with keepCurrentTask", () => {
			const result = taskCommandSchema.safeParse({
				commandName: TaskCommandName.ShowTaskWithId,
				data: { taskId: "task-456", keepCurrentTask: true },
			})
			expect(result.success).toBe(true)
		})

		it("should validate RenameTask command", () => {
			const result = taskCommandSchema.safeParse({
				commandName: TaskCommandName.RenameTask,
				data: { taskId: "task-123", name: "Renamed Task" },
			})
			expect(result.success).toBe(true)
		})

		it("should reject RenameTask command without name", () => {
			const result = taskCommandSchema.safeParse({
				commandName: TaskCommandName.RenameTask,
				data: { taskId: "task-123" },
			})
			expect(result.success).toBe(false)
		})

		it("should validate ArchiveTask command", () => {
			const result = taskCommandSchema.safeParse({
				commandName: TaskCommandName.ArchiveTask,
				data: "task-123",
			})
			expect(result.success).toBe(true)
		})

		it("should validate UnarchiveTask command", () => {
			const result = taskCommandSchema.safeParse({
				commandName: TaskCommandName.UnarchiveTask,
				data: "task-456",
			})
			expect(result.success).toBe(true)
		})

		it("should validate PinTask command", () => {
			const result = taskCommandSchema.safeParse({
				commandName: TaskCommandName.PinTask,
				data: "task-789",
			})
			expect(result.success).toBe(true)
		})

		it("should validate UnpinTask command", () => {
			const result = taskCommandSchema.safeParse({
				commandName: TaskCommandName.UnpinTask,
				data: "task-000",
			})
			expect(result.success).toBe(true)
		})

		it("should validate DeleteTask command", () => {
			const result = taskCommandSchema.safeParse({
				commandName: TaskCommandName.DeleteTask,
				data: { taskId: "task-123" },
			})
			expect(result.success).toBe(true)
		})

		it("should validate DeleteTask command with cascadeSubtasks", () => {
			const result = taskCommandSchema.safeParse({
				commandName: TaskCommandName.DeleteTask,
				data: { taskId: "task-123", cascadeSubtasks: false },
			})
			expect(result.success).toBe(true)
		})

		it("should validate GetTaskMarkdownExport command", () => {
			const result = taskCommandSchema.safeParse({
				commandName: TaskCommandName.GetTaskMarkdownExport,
				data: "task-123",
			})
			expect(result.success).toBe(true)
		})

		it("should validate GetTaskJsonExport command", () => {
			const result = taskCommandSchema.safeParse({
				commandName: TaskCommandName.GetTaskJsonExport,
				data: "task-456",
			})
			expect(result.success).toBe(true)
		})

		it("should validate ExportConfiguration command (no data required)", () => {
			const result = taskCommandSchema.safeParse({
				commandName: TaskCommandName.ExportConfiguration,
			})
			expect(result.success).toBe(true)
		})

		it("should validate ImportConfiguration command", () => {
			const result = taskCommandSchema.safeParse({
				commandName: TaskCommandName.ImportConfiguration,
				data: '{"apiProvider":"openrouter"}',
			})
			expect(result.success).toBe(true)
		})

		it("should reject ArchiveTask command with non-string data", () => {
			const result = taskCommandSchema.safeParse({
				commandName: TaskCommandName.ArchiveTask,
				data: {},
			})
			expect(result.success).toBe(false)
		})

		it("should reject DeleteTask command without taskId", () => {
			const result = taskCommandSchema.safeParse({
				commandName: TaskCommandName.DeleteTask,
				data: {},
			})
			expect(result.success).toBe(false)
		})

		it("should reject ShowTaskWithId command without taskId", () => {
			const result = taskCommandSchema.safeParse({
				commandName: TaskCommandName.ShowTaskWithId,
				data: {},
			})
			expect(result.success).toBe(false)
		})
	})
})
