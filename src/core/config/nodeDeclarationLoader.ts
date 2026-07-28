import fs from "fs/promises"
import * as path from "path"

import {
	EMPTY_NODE_DECLARATION,
	mergeNodeDeclarations,
	parseNodeDeclaration,
	type NodeDeclaration,
	type ParsedNodeDeclaration,
} from "@shofer/core"

import { loadLockedManifest, type ScopeRoots } from "./layeredSettingsLoader"

/**
 * nodeDeclarationLoader — the **host-side** (filesystem) half of `.shofer/nodes.json`
 * (docs/workspace_agent_pool.md §4). The schema and the three-scope merge are pure and
 * live in `@shofer/core`; this module reads the files and resolves the token each
 * declared node names.
 */

/** The per-scope node-declaration filename inside `.shofer/`. */
const NODES_FILE = "nodes.json"

/** The result of reading + merging the three scopes' node declarations. */
export interface LoadedNodeDeclaration {
	/** The merged declaration — the node set this host should be talking to. */
	declaration: NodeDeclaration
	/**
	 * `false` when at least one scope's file existed but could not be parsed. The
	 * caller keeps its previous node set in that case, deliberately deviating from the
	 * Schema-First "corrupt ⇒ empty" rule: emptying a project's pool because of a typo
	 * is a worse failure than running on a stale node list (§5).
	 */
	ok: boolean
	/** Human-readable per-scope parse failures, for the log. Never thrown. */
	errors: string[]
}

/**
 * Read one scope's `.shofer/nodes.json`. A missing file is *not* an error — the scope
 * declares nothing — while a present-but-unparseable file is, and says so.
 */
async function readScopeDeclaration(root: string | undefined): Promise<ParsedNodeDeclaration> {
	if (!root) {
		return { declaration: EMPTY_NODE_DECLARATION, ok: true }
	}
	let raw: string
	try {
		raw = await fs.readFile(path.join(root, NODES_FILE), "utf8")
	} catch {
		return { declaration: EMPTY_NODE_DECLARATION, ok: true }
	}
	return parseNodeDeclaration(raw)
}

/** Read, parse and merge the three scopes' `nodes.json` for the given scope roots. */
export async function loadNodeDeclaration(roots: ScopeRoots): Promise<LoadedNodeDeclaration> {
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
			errors.push(`${scopes[index][0]} scope: ${NODES_FILE} is not a valid node declaration — ignored`)
		}
	})

	return {
		declaration: mergeNodeDeclarations(
			{ global: parsed[0].declaration, user: parsed[1].declaration, project: parsed[2].declaration },
			manifest,
		),
		ok: errors.length === 0,
		errors,
	}
}

/**
 * Read a declared node's bearer token from the file it names.
 *
 * Kept out of the declaration itself so `nodes.json` stays committable and mountable:
 * the file names a path (a projected Kubernetes Secret, typically) and the token is
 * read at connect time, so rotating the secret takes effect on the next connection
 * without rewriting any declaration. Returns `undefined` when the file is absent or
 * unreadable — the connection is then attempted unauthenticated and fails at the node,
 * which is the honest failure and visible in the node's status.
 */
export async function readNodeToken(tokenFile: string | undefined): Promise<string | undefined> {
	if (!tokenFile) {
		return undefined
	}
	try {
		const token = (await fs.readFile(tokenFile, "utf8")).trim()
		return token.length > 0 ? token : undefined
	} catch {
		return undefined
	}
}
