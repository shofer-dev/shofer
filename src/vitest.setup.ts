import fs from "fs"
import os from "os"
import path from "path"

import nock from "nock"

import "@shofer/core" // Import to enable String.prototype.toPosix().

/**
 * The USER configuration scope is `~/.shofer/` (`resolveScopeRoots` in
 * `@shofer/core`), and `os.homedir()` on POSIX is `$HOME`. Left pointing at the
 * developer's real home, every layered-config read in the suite folds in
 * whatever that machine happens to have in `~/.shofer/settings.json` — so a
 * `ContextProxy` assertion passes or fails depending on whose laptop runs it,
 * and does so silently (the overlay is a merge, not an error). Point HOME at an
 * empty per-worker temp directory so the user layer is reliably absent.
 */
const isolatedHome = path.join(os.tmpdir(), `shofer-vitest-home-${process.pid}`)
fs.mkdirSync(isolatedHome, { recursive: true })
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome

// Disable network requests by default for all tests.
nock.disableNetConnect()

export function allowNetConnect(host?: string | RegExp) {
	if (host) {
		nock.enableNetConnect(host)
	} else {
		nock.enableNetConnect()
	}
}

// Global mocks that many tests expect.
global.structuredClone = global.structuredClone || ((obj: any) => JSON.parse(JSON.stringify(obj)))
