// npx vitest src/shared/__tests__/module-isolation.test.ts

/**
 * The Shared Module Isolation Rule, enforced rather than remembered.
 *
 * Everything under `src/shared/` is imported by BOTH the extension host and the
 * `webview-ui/` bundle (through the `@shofer/shared/*` alias). The webview's
 * bundler cannot resolve `vscode` or a Node built-in, and the failure is the
 * worst kind: the module load throws inside the iframe, the React tree never
 * mounts, `resolveWebviewView` still succeeds and the host logs look normal.
 *
 * A table-driven check over the directory is the only form that survives someone
 * adding a new file here — a per-file test would simply not exist for it.
 */

import { readdirSync, readFileSync, statSync } from "fs"
import { builtinModules } from "module"
import * as path from "path"

const SHARED_DIR = path.resolve(import.meta.dirname, "..")

/** Every `.ts` under `src/shared/`, excluding tests and ambient declarations. */
function sharedModules(dir = SHARED_DIR): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = path.join(dir, entry)
		if (statSync(full).isDirectory()) {
			return entry === "__tests__" ? [] : sharedModules(full)
		}
		if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) return []
		return [full]
	})
}

/**
 * Static import specifiers only. A `type`-only import erases at compile time and
 * never reaches the bundler, so `import type { X } from "vscode"` is legal here
 * and is deliberately not matched; a dynamic `import()` is host-gated by its call
 * site and likewise out of scope.
 */
function staticImportSpecifiers(source: string): string[] {
	const specifiers: string[] = []
	const importRe = /^\s*import\s+(?!type\b)([^;]*?)\s*from\s*["']([^"']+)["']/gm
	const bareRe = /^\s*import\s+["']([^"']+)["']/gm
	const exportRe = /^\s*export\s+(?!type\b)(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/gm

	for (const [, clause, specifier] of source.matchAll(importRe)) {
		// `import { type A, type B } from "x"` is also erased.
		const named = clause.match(/^\{([\s\S]*)\}$/)
		if (named && named[1].split(",").every((part) => !part.trim() || /^type\s/.test(part.trim()))) continue
		specifiers.push(specifier)
	}
	for (const [, specifier] of source.matchAll(bareRe)) specifiers.push(specifier)
	for (const [, specifier] of source.matchAll(exportRe)) specifiers.push(specifier)

	return specifiers
}

const FORBIDDEN_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

const modules = sharedModules()

describe("src/shared/** is host-agnostic", () => {
	it("has modules to check at all — an empty sweep would pass vacuously", () => {
		expect(modules.length).toBeGreaterThan(0)
	})

	it.each(modules.map((f) => [path.relative(SHARED_DIR, f), f]))(
		"%s does not statically import `vscode` or a Node built-in",
		(_name, file) => {
			const offenders = staticImportSpecifiers(readFileSync(file, "utf8")).filter(
				(s) => s === "vscode" || FORBIDDEN_BUILTINS.has(s),
			)

			expect(offenders).toEqual([])
		},
	)

	it.each(modules.map((f) => [path.relative(SHARED_DIR, f), f]))(
		"%s does not reach into a host-only service",
		(_name, file) => {
			const offenders = staticImportSpecifiers(readFileSync(file, "utf8")).filter((s) =>
				/(ContextProxy|TaskManager|SkillsManager|outputChannelLogger|ShoferProvider)/.test(s),
			)

			expect(offenders).toEqual([])
		},
	)

	it("every shared module LOADS in a node context with no vscode host installed", async () => {
		for (const file of modules) {
			await expect(import(/* @vite-ignore */ file)).resolves.toBeDefined()
		}
	})
})

describe("the checker itself", () => {
	it("ignores type-only imports, which erase before the bundler sees them", () => {
		expect(staticImportSpecifiers(`import type { Uri } from "vscode"\n`)).toEqual([])
		expect(staticImportSpecifiers(`import { type Uri, type Range } from "vscode"\n`)).toEqual([])
	})

	it("catches a value import, a bare side-effect import and a re-export", () => {
		expect(staticImportSpecifiers(`import * as vscode from "vscode"\n`)).toEqual(["vscode"])
		expect(staticImportSpecifiers(`import "fs"\n`)).toEqual(["fs"])
		expect(staticImportSpecifiers(`export * from "path"\n`)).toEqual(["path"])
		expect(staticImportSpecifiers(`import { Uri, type Range } from "vscode"\n`)).toEqual(["vscode"])
	})
})
