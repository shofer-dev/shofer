import { z } from "zod"

import { EMPTY_LOCKED_MANIFEST, isPathLocked, type LockedManifest } from "./layered-config.js"

/**
 * worker-declaration — `.shofer/workers.json`, the file that says which **Shofer Workers**
 * a scope wants this host to talk to (docs/workspace_agent_pool.md §4).
 *
 * WHY A FILE: worker definitions live in `globalState` and are mutable from exactly one
 * place — the `shoferWorker` webview message. That makes a platform-provisioned pool
 * impossible twice over: nothing outside the UI can add a worker, and a headless host has
 * no UI at all. Provisioning a workspace's runner pool should be *writing data*
 * (resource-manager rewrites a file; every running host reconciles), which is how
 * settings, modes and plugins already work.
 *
 * WHY NOT A `settings.json` KEY: the layered merge replaces arrays and scalars
 * **wholesale**, so a worker *list* under a settings key would be destroyed by any
 * user-scope entry — and locking the key to prevent that would also forbid the user
 * adding a worker of their own. Per-**entity** merge (the `plugins.json` shape, reusing
 * the same lock predicate) is what lets the platform's worker be locked while the user
 * still adds theirs.
 *
 * NO SECRETS: the connection token stays out of the file and is named by reference
 * (`tokenFile`), exactly as `settings.json` names a provider profile rather than
 * carrying its key. The file is meant to be committed, mounted from a ConfigMap, and
 * read by anyone who can read the workspace.
 *
 * Pure: no disk, no scope-root resolution, no `vscode`. The host half lives in
 * `src/core/config/workerDeclarationLoader.ts`.
 */

/**
 * Current on-disk version of `.shofer/workers.json`. Bump when the shape changes; a
 * mismatched version is discarded (Versioned Snapshot Rule).
 */
export const WORKER_DECLARATION_VERSION = 1

/**
 * One worker's declaration entry. Mirrors the non-secret half of `ShoferWorkerDef` — the
 * id is the map key, and `kind` is implied (a declared worker is always remote; the
 * Local worker is this process and cannot be declared).
 */
export const workerDeclarationEntrySchema = z
	.object({
		/** Friendly name shown in the Workers list. Defaults to the entry's id. */
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
		 * Absolute path to a file holding this worker's bearer token — a projected
		 * Kubernetes Secret, typically. Read at connect time, never cached to disk by
		 * us and never surfaced to the webview.
		 */
		tokenFile: z.string().min(1).optional(),
		/**
		 * Name of an environment variable holding this worker's bearer token. The same
		 * indirection as {@link tokenFile} for a host whose secret arrives as env
		 * rather than as a file — which is the common k8s shape, since a `secretKeyRef`
		 * puts the value in the environment without either side naming it. Read at
		 * connect time; `tokenFile` wins if both are set.
		 */
		tokenEnv: z.string().min(1).optional(),
	})
	.strict()

export type WorkerDeclarationEntry = z.infer<typeof workerDeclarationEntrySchema>

/** Schema for `.shofer/workers.json`. Fail-closed: unknown keys rejected, version pinned. */
export const workerDeclarationSchema = z
	.object({
		version: z.literal(WORKER_DECLARATION_VERSION),
		workers: z.record(z.string().min(1), workerDeclarationEntrySchema),
	})
	.strict()

export type WorkerDeclaration = z.infer<typeof workerDeclarationSchema>

/** An empty declaration — no workers declared. */
export const EMPTY_WORKER_DECLARATION: WorkerDeclaration = { version: WORKER_DECLARATION_VERSION, workers: {} }

/** The outcome of parsing one scope's `workers.json`. */
export interface ParsedWorkerDeclaration {
	declaration: WorkerDeclaration
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
 * Parse raw `.shofer/workers.json` content, failing closed to
 * {@link EMPTY_WORKER_DECLARATION} and reporting whether the parse succeeded. Accepts
 * the file string or an already-parsed object.
 */
export function parseWorkerDeclaration(raw: unknown): ParsedWorkerDeclaration {
	let json: unknown = raw
	if (typeof raw === "string") {
		try {
			json = JSON.parse(raw)
		} catch {
			return { declaration: EMPTY_WORKER_DECLARATION, ok: false }
		}
	}
	const result = workerDeclarationSchema.safeParse(json)
	return result.success
		? { declaration: result.data, ok: true }
		: { declaration: EMPTY_WORKER_DECLARATION, ok: false }
}

/** The three scope layers of `.shofer/workers.json`, least- to most-specific. */
export interface WorkerDeclarationLayers {
	global?: WorkerDeclaration
	user?: WorkerDeclaration
	project?: WorkerDeclaration
}

/**
 * Cross-merge the three scopes' worker declarations, per worker id, under the same
 * locked-vs-default rule as settings and plugins:
 *
 *   - **Locked** (`workers/<id>` in the global scope's `locked.json`) **and** declared by
 *     global → the global entry wins and is final. That is how a platform-provisioned
 *     runner survives a user's `workers.json`: they may still *disable* it through the UI
 *     (a runtime flag, not a declaration), but they cannot re-point or delete it.
 *   - **Unlocked** → more-specific wins: `project ?? user ?? global`, whole entry.
 *   - A user or project may always add ids global never declared.
 */
export function mergeWorkerDeclarations(
	layers: WorkerDeclarationLayers,
	manifest: LockedManifest = EMPTY_LOCKED_MANIFEST,
): WorkerDeclaration {
	const globalWorkers = layers.global?.workers ?? {}
	const userWorkers = layers.user?.workers ?? {}
	const projectWorkers = layers.project?.workers ?? {}

	const ids = new Set<string>([
		...Object.keys(globalWorkers),
		...Object.keys(userWorkers),
		...Object.keys(projectWorkers),
	])

	const merged: Record<string, WorkerDeclarationEntry> = {}
	for (const id of ids) {
		const globalEntry = globalWorkers[id]
		if (globalEntry !== undefined && isPathLocked(`workers/${id}`, manifest)) {
			merged[id] = globalEntry
			continue
		}
		const winner = projectWorkers[id] ?? userWorkers[id] ?? globalEntry
		if (winner !== undefined) merged[id] = winner
	}

	return { version: WORKER_DECLARATION_VERSION, workers: merged }
}
