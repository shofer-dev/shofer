import { z } from "zod"

import { EMPTY_LOCKED_MANIFEST, isPathLocked, type LockedManifest } from "./layered-config.js"

/**
 * node-declaration — `.shofer/nodes.json`, the file that says which **Shofer Nodes**
 * a scope wants this host to talk to (docs/workspace_agent_pool.md §4).
 *
 * WHY A FILE: node definitions live in `globalState` and are mutable from exactly one
 * place — the `shoferNode` webview message. That makes a platform-provisioned pool
 * impossible twice over: nothing outside the UI can add a node, and a headless host has
 * no UI at all. Provisioning a workspace's runner pool should be *writing data*
 * (resource-manager rewrites a file; every running host reconciles), which is how
 * settings, modes and plugins already work.
 *
 * WHY NOT A `settings.json` KEY: the layered merge replaces arrays and scalars
 * **wholesale**, so a node *list* under a settings key would be destroyed by any
 * user-scope entry — and locking the key to prevent that would also forbid the user
 * adding a node of their own. Per-**entity** merge (the `plugins.json` shape, reusing
 * the same lock predicate) is what lets the platform's node be locked while the user
 * still adds theirs.
 *
 * NO SECRETS: the connection token stays out of the file and is named by reference
 * (`tokenFile`), exactly as `settings.json` names a provider profile rather than
 * carrying its key. The file is meant to be committed, mounted from a ConfigMap, and
 * read by anyone who can read the workspace.
 *
 * Pure: no disk, no scope-root resolution, no `vscode`. The host half lives in
 * `src/core/config/nodeDeclarationLoader.ts`.
 */

/**
 * Current on-disk version of `.shofer/nodes.json`. Bump when the shape changes; a
 * mismatched version is discarded (Versioned Snapshot Rule).
 */
export const NODE_DECLARATION_VERSION = 1

/**
 * One node's declaration entry. Mirrors the non-secret half of `ShoferNodeDef` — the
 * id is the map key, and `kind` is implied (a declared node is always remote; the
 * Local node is this process and cannot be declared).
 */
export const nodeDeclarationEntrySchema = z
	.object({
		/** Friendly name shown in the Nodes list. Defaults to the entry's id. */
		label: z.string().min(1).optional(),
		/** `host:port` or DNS name, composed into `http(s)://<host>/api/v1`. */
		host: z.string().min(1),
		/** Use `https` for the control plane. */
		tls: z.boolean().optional(),
		/** Connect on start, and on appearing in the file. Defaults to `true`. */
		autoConnect: z.boolean().optional(),
		/** Administratively out of the pool. */
		disabled: z.boolean().optional(),
		/**
		 * Absolute path to a file holding this node's bearer token — a projected
		 * Kubernetes Secret, typically. Read at connect time, never cached to disk by
		 * us and never surfaced to the webview.
		 */
		tokenFile: z.string().min(1).optional(),
	})
	.strict()

export type NodeDeclarationEntry = z.infer<typeof nodeDeclarationEntrySchema>

/** Schema for `.shofer/nodes.json`. Fail-closed: unknown keys rejected, version pinned. */
export const nodeDeclarationSchema = z
	.object({
		version: z.literal(NODE_DECLARATION_VERSION),
		nodes: z.record(z.string().min(1), nodeDeclarationEntrySchema),
	})
	.strict()

export type NodeDeclaration = z.infer<typeof nodeDeclarationSchema>

/** An empty declaration — no nodes declared. */
export const EMPTY_NODE_DECLARATION: NodeDeclaration = { version: NODE_DECLARATION_VERSION, nodes: {} }

/** The outcome of parsing one scope's `nodes.json`. */
export interface ParsedNodeDeclaration {
	declaration: NodeDeclaration
	/**
	 * `false` when the file was present but unusable (corrupt JSON, shape or version
	 * mismatch). The caller distinguishes this from "no file", because the two deserve
	 * opposite responses: absence means the scope declares nothing, corruption means
	 * this scope's contribution is *unknown* and the last good one should stand
	 * (docs/workspace_agent_pool.md §5) rather than the pool emptying over a typo.
	 */
	ok: boolean
}

/**
 * Parse raw `.shofer/nodes.json` content, failing closed to
 * {@link EMPTY_NODE_DECLARATION} and reporting whether the parse succeeded. Accepts
 * the file string or an already-parsed object.
 */
export function parseNodeDeclaration(raw: unknown): ParsedNodeDeclaration {
	let json: unknown = raw
	if (typeof raw === "string") {
		try {
			json = JSON.parse(raw)
		} catch {
			return { declaration: EMPTY_NODE_DECLARATION, ok: false }
		}
	}
	const result = nodeDeclarationSchema.safeParse(json)
	return result.success ? { declaration: result.data, ok: true } : { declaration: EMPTY_NODE_DECLARATION, ok: false }
}

/** The three scope layers of `.shofer/nodes.json`, least- to most-specific. */
export interface NodeDeclarationLayers {
	global?: NodeDeclaration
	user?: NodeDeclaration
	project?: NodeDeclaration
}

/**
 * Cross-merge the three scopes' node declarations, per node id, under the same
 * locked-vs-default rule as settings and plugins:
 *
 *   - **Locked** (`nodes/<id>` in the global scope's `locked.json`) **and** declared by
 *     global → the global entry wins and is final. That is how a platform-provisioned
 *     runner survives a user's `nodes.json`: they may still *disable* it through the UI
 *     (a runtime flag, not a declaration), but they cannot re-point or delete it.
 *   - **Unlocked** → more-specific wins: `project ?? user ?? global`, whole entry.
 *   - A user or project may always add ids global never declared.
 */
export function mergeNodeDeclarations(
	layers: NodeDeclarationLayers,
	manifest: LockedManifest = EMPTY_LOCKED_MANIFEST,
): NodeDeclaration {
	const globalNodes = layers.global?.nodes ?? {}
	const userNodes = layers.user?.nodes ?? {}
	const projectNodes = layers.project?.nodes ?? {}

	const ids = new Set<string>([...Object.keys(globalNodes), ...Object.keys(userNodes), ...Object.keys(projectNodes)])

	const merged: Record<string, NodeDeclarationEntry> = {}
	for (const id of ids) {
		const globalEntry = globalNodes[id]
		if (globalEntry !== undefined && isPathLocked(`nodes/${id}`, manifest)) {
			merged[id] = globalEntry
			continue
		}
		const winner = projectNodes[id] ?? userNodes[id] ?? globalEntry
		if (winner !== undefined) merged[id] = winner
	}

	return { version: NODE_DECLARATION_VERSION, nodes: merged }
}
