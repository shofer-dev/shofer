import { describe, it, expect } from "vitest"

import { pluginManifestSchema, pluginPermissionsSchema } from "../plugin.js"

describe("pluginManifestSchema (design §5)", () => {
	const minimal = { name: "my-plugin", version: "1.0.0" }

	it("accepts a minimal manifest (name + version only)", () => {
		const result = pluginManifestSchema.safeParse(minimal)
		expect(result.success).toBe(true)
	})

	it("accepts a full declarative manifest", () => {
		const manifest = {
			name: "my-org-ci",
			version: "1.0.0",
			description: "CI/CD integration",
			author: "DevOps Team",
			homepage: "https://example.com",
			license: "MIT",
			shoferVersion: ">=1.0.0",
			main: null,
			permissions: {
				modes: true,
				skills: true,
				commands: true,
				mcpServers: true,
				rules: true,
				ui: ["chat-input-toolbar", "task-header"],
				network: ["https://jenkins.my-org.com"],
				filesystem: ["./ci-config/"],
			},
			contributes: {
				modes: [
					{
						slug: "deploy",
						name: "🚀 Deploy",
						roleDefinition: "You are a deployment specialist",
						tools: ["read", "execute", "mcp"],
						customInstructions: "Use the CI tools to deploy",
					},
				],
				skills: [{ name: "deploy-to-staging", description: "Deploy the current branch to staging" }],
				commands: [
					{ name: "deploy", description: "Deploy the current project", argumentHint: "<environment>" },
				],
				mcpServers: {
					jenkins: { type: "streamable-http", url: "https://jenkins.my-org.com/mcp" },
				},
				rules: [{ path: "rules/deploy-rules.md", modes: ["deploy", "code"] }],
			},
			dependencies: ["git-integration"],
			config: { jenkinsUrl: { type: "string" } },
		}
		const result = pluginManifestSchema.safeParse(manifest)
		expect(result.success).toBe(true)
	})

	it("rejects a manifest missing the required name", () => {
		const result = pluginManifestSchema.safeParse({ version: "1.0.0" })
		expect(result.success).toBe(false)
	})

	it("accepts an optional shoferPluginApiVersion (design §14.2)", () => {
		const result = pluginManifestSchema.safeParse({ ...minimal, shoferPluginApiVersion: "1.0.0" })
		expect(result.success).toBe(true)
	})

	it("rejects a manifest missing the required version", () => {
		const result = pluginManifestSchema.safeParse({ name: "x" })
		expect(result.success).toBe(false)
	})

	it("rejects an invalid plugin name", () => {
		const result = pluginManifestSchema.safeParse({ name: "-bad name", version: "1.0.0" })
		expect(result.success).toBe(false)
	})

	it("fail-closed: rejects unknown top-level fields", () => {
		const result = pluginManifestSchema.safeParse({ ...minimal, bogusField: 1 })
		expect(result.success).toBe(false)
	})

	it("fail-closed: rejects unknown fields inside contributes", () => {
		const result = pluginManifestSchema.safeParse({ ...minimal, contributes: { widgets: [] } })
		expect(result.success).toBe(false)
	})

	it("fail-closed: rejects unknown fields inside permissions", () => {
		const result = pluginPermissionsSchema.safeParse({ superpowers: true })
		expect(result.success).toBe(false)
	})

	it("accepts the mcpInvoke grant, and keeps it independent of mcpServers (§5.6)", () => {
		expect(pluginPermissionsSchema.safeParse({ mcpInvoke: true }).success).toBe(true)
		// Contributing a server and invoking one are separate grants: holding either
		// alone is a valid manifest, so a plugin cannot reach `ctx.mcp` by declaring
		// `mcpServers`, nor is it forced to contribute one in order to invoke.
		const contributesOnly = pluginPermissionsSchema.parse({ mcpServers: true })
		expect(contributesOnly.mcpInvoke).toBeUndefined()
		const invokesOnly = pluginPermissionsSchema.parse({ mcpInvoke: true })
		expect(invokesOnly.mcpServers).toBeUndefined()
	})

	it("rejects a contributed mode that declares no tools", () => {
		const result = pluginManifestSchema.safeParse({
			...minimal,
			contributes: { modes: [{ slug: "x", name: "X", roleDefinition: "r" }] },
		})
		expect(result.success).toBe(false)
	})

	it("rejects an unknown UI region", () => {
		const result = pluginManifestSchema.safeParse({ ...minimal, permissions: { ui: ["nope"] } })
		expect(result.success).toBe(false)
	})

	it("does not let a contributed mode override source/pluginName", () => {
		const result = pluginManifestSchema.safeParse({
			...minimal,
			contributes: {
				modes: [{ slug: "x", name: "X", roleDefinition: "r", tools: ["read"], source: "global" }],
			},
		})
		expect(result.success).toBe(false)
	})
})
