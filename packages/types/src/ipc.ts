import { z } from "zod"

import { type TaskEvent, taskEventSchema } from "./events.js"
import { shoferSettingsSchema } from "./global-settings.js"

/**
 * IpcMessageType
 */

export enum IpcMessageType {
	Connect = "Connect",
	Disconnect = "Disconnect",
	Ack = "Ack",
	TaskCommand = "TaskCommand",
	TaskEvent = "TaskEvent",
}

/**
 * IpcOrigin
 */

export enum IpcOrigin {
	Client = "client",
	Server = "server",
}

/**
 * Ack
 */

export const ackSchema = z.object({
	clientId: z.string(),
	pid: z.number(),
	ppid: z.number(),
})

export type Ack = z.infer<typeof ackSchema>

/**
 * TaskCommandName
 */

export enum TaskCommandName {
	StartNewTask = "StartNewTask",
	CancelTask = "CancelTask",
	CloseTask = "CloseTask",
	ResumeTask = "ResumeTask",
	SendMessage = "SendMessage",
	GetCommands = "GetCommands",
	GetModes = "GetModes",
	GetModels = "GetModels",
	DeleteQueuedMessage = "DeleteQueuedMessage",
	ShowTaskWithId = "ShowTaskWithId",
	RenameTask = "RenameTask",
	ArchiveTask = "ArchiveTask",
	UnarchiveTask = "UnarchiveTask",
	PinTask = "PinTask",
	UnpinTask = "UnpinTask",
	DeleteTask = "DeleteTask",
	GetTaskMarkdownExport = "GetTaskMarkdownExport",
	GetTaskJsonExport = "GetTaskJsonExport",
	ExportConfiguration = "ExportConfiguration",
	ImportConfiguration = "ImportConfiguration",
}

/**
 * TaskCommand
 */

export const taskCommandSchema = z.discriminatedUnion("commandName", [
	z.object({
		commandName: z.literal(TaskCommandName.StartNewTask),
		data: z.object({
			configuration: shoferSettingsSchema,
			text: z.string(),
			images: z.array(z.string()).optional(),
			newTab: z.boolean().optional(),
		}),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.CancelTask),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.CloseTask),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.ResumeTask),
		data: z.string(),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.SendMessage),
		data: z.object({
			text: z.string().optional(),
			images: z.array(z.string()).optional(),
		}),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.GetCommands),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.GetModes),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.GetModels),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.DeleteQueuedMessage),
		data: z.string(), // messageId
	}),
	z.object({
		commandName: z.literal(TaskCommandName.ShowTaskWithId),
		data: z.object({
			taskId: z.string(),
			keepCurrentTask: z.boolean().optional(),
		}),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.RenameTask),
		data: z.object({
			taskId: z.string(),
			name: z.string(),
		}),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.ArchiveTask),
		data: z.string(), // taskId
	}),
	z.object({
		commandName: z.literal(TaskCommandName.UnarchiveTask),
		data: z.string(), // taskId
	}),
	z.object({
		commandName: z.literal(TaskCommandName.PinTask),
		data: z.string(), // taskId
	}),
	z.object({
		commandName: z.literal(TaskCommandName.UnpinTask),
		data: z.string(), // taskId
	}),
	z.object({
		commandName: z.literal(TaskCommandName.DeleteTask),
		data: z.object({
			taskId: z.string(),
			cascadeSubtasks: z.boolean().optional(),
		}),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.GetTaskMarkdownExport),
		data: z.string(), // taskId
	}),
	z.object({
		commandName: z.literal(TaskCommandName.GetTaskJsonExport),
		data: z.string(), // taskId
	}),
	z.object({
		commandName: z.literal(TaskCommandName.ExportConfiguration),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.ImportConfiguration),
		data: z.string(), // JSON string
	}),
])

export type TaskCommand = z.infer<typeof taskCommandSchema>

/**
 * IpcMessage
 */

export const ipcMessageSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal(IpcMessageType.Ack),
		origin: z.literal(IpcOrigin.Server),
		data: ackSchema,
	}),
	z.object({
		type: z.literal(IpcMessageType.TaskCommand),
		origin: z.literal(IpcOrigin.Client),
		clientId: z.string(),
		data: taskCommandSchema,
	}),
	z.object({
		type: z.literal(IpcMessageType.TaskEvent),
		origin: z.literal(IpcOrigin.Server),
		relayClientId: z.string().optional(),
		data: taskEventSchema,
	}),
])

export type IpcMessage = z.infer<typeof ipcMessageSchema>

/**
 * IpcClientEvents
 */

export type IpcClientEvents = {
	[IpcMessageType.Connect]: []
	[IpcMessageType.Disconnect]: []
	[IpcMessageType.Ack]: [data: Ack]
	[IpcMessageType.TaskCommand]: [data: TaskCommand]
	[IpcMessageType.TaskEvent]: [data: TaskEvent]
}

/**
 * IpcServerEvents
 */

export type IpcServerEvents = {
	[IpcMessageType.Connect]: [clientId: string]
	[IpcMessageType.Disconnect]: [clientId: string]
	[IpcMessageType.TaskCommand]: [clientId: string, data: TaskCommand]
	[IpcMessageType.TaskEvent]: [relayClientId: string | undefined, data: TaskEvent]
}
