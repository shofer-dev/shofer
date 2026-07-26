import { describe, it, expect } from "vitest"

import { resolvePluginRequestTarget } from "../pluginUiRequestRouting"

const BLOCKED = "A task is running in this workspace."

describe("resolvePluginRequestTarget", () => {
	it("answers locally when no remote shadow is focused", () => {
		expect(
			resolvePluginRequestTarget({ method: "diff", hasActiveLocalTask: false, blockedMessage: BLOCKED }),
		).toEqual({ target: "local" })
	})

	it("routes to the executor that owns a focused shadow task", () => {
		expect(
			resolvePluginRequestTarget({
				method: "diff",
				shadowTaskId: "r1-task-1",
				hasActiveLocalTask: false,
				blockedMessage: BLOCKED,
			}),
		).toEqual({ target: "shadow", taskId: "r1-task-1" })
	})

	it("keeps a `local:` method on this host even with a shadow focused", () => {
		// Opening a diff viewer on a headless executor would silently do nothing.
		expect(
			resolvePluginRequestTarget({
				method: "local:show-diff",
				shadowTaskId: "r1-task-1",
				hasActiveLocalTask: false,
				blockedMessage: BLOCKED,
			}),
		).toEqual({ target: "local" })
	})

	it("refuses a mutating remote request while a local task shares the workspace", () => {
		expect(
			resolvePluginRequestTarget({
				method: "restore",
				mutates: true,
				shadowTaskId: "r1-task-1",
				hasActiveLocalTask: true,
				blockedMessage: BLOCKED,
			}),
		).toEqual({ blocked: BLOCKED })
	})

	it("still allows a READ against a shadow while a local task runs", () => {
		expect(
			resolvePluginRequestTarget({
				method: "diff",
				shadowTaskId: "r1-task-1",
				hasActiveLocalTask: true,
				blockedMessage: BLOCKED,
			}),
		).toEqual({ target: "shadow", taskId: "r1-task-1" })
	})

	it("does not block a mutating LOCAL request — the host owns its own workspace", () => {
		expect(
			resolvePluginRequestTarget({
				method: "restore",
				mutates: true,
				hasActiveLocalTask: true,
				blockedMessage: BLOCKED,
			}),
		).toEqual({ target: "local" })
	})
})
