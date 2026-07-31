import fs from "fs/promises"
import * as path from "path"

import {
	EMPTY_WORKER_DECLARATION,
	mergeWorkerDeclarations,
	parseWorkerDeclaration,
	type WorkerDeclaration,
	type ParsedWorkerDeclaration,
} from "@shofer/core"

import { loadLockedManifest, type ScopeRoots } from "./layeredSettingsLoader"

/**
 * workerDeclarationLoader — the **host-side** (filesystem) half of `.shofer/workers.json`
 * (docs/workspace_agent_pool.md §4). The schema and the three-scope merge are pure and
 * live in `@shofer/core`; this module reads the files and resolves the token each
 * declared worker names.
 */

/** The per-scope worker-declaration filename inside `.shofer/`. */
const WORKERS_FILE = "workers.json"

/** The result of reading + merging the three scopes' worker declarations. */
export interface LoadedWorkerDeclaration {
	/** The merged declaration — the worker set this host should be talking to. */
	declaration: WorkerDeclaration
	/**
	 * `false` when at least one scope's file existed but could not be parsed. The
	 * caller keeps its previous worker set in that case, deliberately deviating from the
	 * Schema-First "corrupt ⇒ empty" rule: emptying a project's pool because of a typo
	 * is a worse failure than running on a stale worker list (§5).
	 */
	ok: boolean
	/** Human-readable per-scope parse failures, for the log. Never thrown. */
	errors: string[]
}

/**
 * Read one scope's `.shofer/workers.json`. A missing file is *not* an error — the scope
 * declares nothing — while a present-but-unparseable file is, and says so.
 */
async function readScopeDeclaration(root: string | undefined): Promise<ParsedWorkerDeclaration> {
	if (!root) {
		return { declaration: EMPTY_WORKER_DECLARATION, ok: true }
	}
	let raw: string
	try {
		raw = await fs.readFile(path.join(root, WORKERS_FILE), "utf8")
	} catch {
		return { declaration: EMPTY_WORKER_DECLARATION, ok: true }
	}
	return parseWorkerDeclaration(raw)
}

/** Read, parse and merge the three scopes' `workers.json` for the given scope roots. */
export async function loadWorkerDeclaration(roots: ScopeRoots): Promise<LoadedWorkerDeclaration> {
	const scopes = [
		["global", roots.global],
		["user", roots.user],
		["project", roots.project],
	] as const

	const [parsed, manifest] = await Promise.all([
		Promise.all(scopes.map(([, root]) => readScopeDeclaration(root))),
		loadLockedManifest(roots.global),
	])

	const errors: string[] = []
	parsed.forEach((result, index) => {
		if (!result.ok) {
			errors.push(`${scopes[index][0]} scope: ${WORKERS_FILE} is not a valid worker declaration — ignored`)
		}
	})

	return {
		declaration: mergeWorkerDeclarations(
			{ global: parsed[0].declaration, user: parsed[1].declaration, project: parsed[2].declaration },
			manifest,
		),
		ok: errors.length === 0,
		errors,
	}
}

/**
 * Resolve a declared worker's bearer token from whichever indirection the declaration
 * named: a file (`tokenFile` — a projected Kubernetes Secret, typically) or an
 * environment variable (`tokenEnv` — the shape a `secretKeyRef` produces).
 *
 * The token is kept out of `workers.json` itself so the file stays committable and
 * mountable, and it is resolved at connect time, so rotating the secret takes effect
 * on the next connection with no declaration to rewrite. Returns `undefined` when
 * neither reference resolves — the connection is then attempted unauthenticated and
 * refused at the worker, which is the honest failure and visible in the worker's status.
 */
export async function readWorkerToken(source: { tokenFile?: string; tokenEnv?: string }): Promise<string | undefined> {
	if (source.tokenFile) {
		try {
			const token = (await fs.readFile(source.tokenFile, "utf8")).trim()
			if (token.length > 0) {
				return token
			}
		} catch {
			// Fall through to the env reference, if the declaration named one.
		}
	}
	if (source.tokenEnv) {
		const token = process.env[source.tokenEnv]?.trim()
		return token && token.length > 0 ? token : undefined
	}
	return undefined
}
