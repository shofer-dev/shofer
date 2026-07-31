import { describe, it, expect } from "vitest"

import {
	EMPTY_WORKER_DECLARATION,
	WORKER_DECLARATION_VERSION,
	mergeWorkerDeclarations,
	parseWorkerDeclaration,
	type WorkerDeclaration,
} from "../worker-declaration.js"
import { parseLockedManifest } from "../layered-config.js"

/**
 * `.shofer/workers.json` — the declaration that lets a pool be provisioned by writing a
 * file (docs/workspace_agent_pool.md §4). Two properties carry the design and are what
 * these tests pin: a corrupt file is *reported* rather than silently treated as empty
 * (so the caller can keep its last good set), and the merge is **per entity**, which is
 * the whole reason this is not a `settings.json` key.
 */
describe("worker declaration", () => {
	const decl = (workers: WorkerDeclaration["workers"]): WorkerDeclaration => ({
		version: WORKER_DECLARATION_VERSION,
		workers,
	})

	describe("parseWorkerDeclaration", () => {
		it("parses a valid declaration", () => {
			const result = parseWorkerDeclaration(
				JSON.stringify({
					version: 1,
					workers: { "pool-0": { label: "runner-0", host: "runner-0.ws.svc:30099", autoConnect: true } },
				}),
			)
			expect(result.ok).toBe(true)
			expect(result.declaration.workers["pool-0"]?.host).toBe("runner-0.ws.svc:30099")
		})

		it("reports corrupt JSON rather than pretending the scope declares nothing", () => {
			const result = parseWorkerDeclaration("{ not json")
			expect(result).toEqual({ declaration: EMPTY_WORKER_DECLARATION, ok: false })
		})

		it("rejects a version it does not know", () => {
			expect(parseWorkerDeclaration(JSON.stringify({ version: 2, workers: {} })).ok).toBe(false)
		})

		it("rejects an entry with no host — a worker with no address is not a worker", () => {
			expect(parseWorkerDeclaration(JSON.stringify({ version: 1, workers: { a: { label: "a" } } })).ok).toBe(
				false,
			)
		})

		it("rejects unknown keys, so a typo is loud instead of ignored", () => {
			const raw = JSON.stringify({ version: 1, workers: { a: { host: "h:1", autoconnect: true } } })
			expect(parseWorkerDeclaration(raw).ok).toBe(false)
		})

		it("never carries a token — only a reference to one", () => {
			const raw = JSON.stringify({ version: 1, workers: { a: { host: "h:1", token: "sk-secret" } } })
			expect(parseWorkerDeclaration(raw).ok).toBe(false)
		})
	})

	describe("mergeWorkerDeclarations", () => {
		it("takes the union across scopes", () => {
			const merged = mergeWorkerDeclarations({
				global: decl({ platform: { host: "p:1" } }),
				user: decl({ mine: { host: "m:1" } }),
			})
			expect(Object.keys(merged.workers).sort()).toEqual(["mine", "platform"])
		})

		it("lets a more specific scope re-point an unlocked worker", () => {
			const merged = mergeWorkerDeclarations({
				global: decl({ a: { host: "global:1" } }),
				user: decl({ a: { host: "user:1" } }),
				project: decl({ a: { host: "project:1" } }),
			})
			expect(merged.workers.a?.host).toBe("project:1")
		})

		it("makes a locked global worker final", () => {
			const manifest = parseLockedManifest({ version: 1, locked: ["workers/a"] })
			const merged = mergeWorkerDeclarations(
				{ global: decl({ a: { host: "global:1" } }), user: decl({ a: { host: "user:1" } }) },
				manifest,
			)
			expect(merged.workers.a?.host).toBe("global:1")
		})

		it("still lets the user ADD workers when another id is locked", () => {
			// The property that makes per-entity merge necessary: locking the platform's
			// worker must not cost the user the ability to register one of their own.
			const manifest = parseLockedManifest({ version: 1, locked: ["workers/a"] })
			const merged = mergeWorkerDeclarations(
				{ global: decl({ a: { host: "global:1" } }), user: decl({ b: { host: "user:1" } }) },
				manifest,
			)
			expect(merged.workers.a?.host).toBe("global:1")
			expect(merged.workers.b?.host).toBe("user:1")
		})

		it("ignores a lock on an id the global scope never declared", () => {
			const manifest = parseLockedManifest({ version: 1, locked: ["workers/a"] })
			const merged = mergeWorkerDeclarations({ user: decl({ a: { host: "user:1" } }) }, manifest)
			expect(merged.workers.a?.host).toBe("user:1")
		})

		it("is pure — the input layers are not mutated", () => {
			const global = decl({ a: { host: "global:1" } })
			const snapshot = JSON.stringify(global)
			mergeWorkerDeclarations({ global, user: decl({ a: { host: "user:1" } }) })
			expect(JSON.stringify(global)).toBe(snapshot)
		})
	})
})
