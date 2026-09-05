/**
 * Unit tests for the parts of `shofer upgrade` (`src/commands/cli/upgrade.ts`)
 * that reach outside the process: the GitHub release scan and the installer
 * subprocess.
 *
 * `fetch` is supplied per call (the module takes an injectable `fetchImpl`) and
 * `child_process.spawn` is mocked, so no release API is contacted and the
 * install script is never executed. The version-comparison unit tests live in
 * `upgrade.test.ts`; this file covers the failure shapes around them.
 */

import {
	INSTALL_SCRIPT_COMMAND,
	compareVersions,
	getLatestCliVersion,
	runUpgradeInstaller,
	upgrade,
} from "../upgrade.js"

type CloseListener = (code: number | null, signal: NodeJS.Signals | null) => void

const spawnState = vi.hoisted(() => ({
	calls: [] as Array<{ command: string; args: string[]; options: Record<string, unknown> }>,
	/** How the faked child process ends. */
	outcome: { kind: "close", code: 0 } as
		| { kind: "close"; code: number | null; signal?: NodeJS.Signals }
		| { kind: "error"; error: Error },
}))

const spawn = vi.hoisted(() =>
	vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
		spawnState.calls.push({ command, args, options })
		const listeners = new Map<string, (...cbArgs: never[]) => void>()
		queueMicrotask(() => {
			if (spawnState.outcome.kind === "error") {
				;(listeners.get("error") as ((e: Error) => void) | undefined)?.(spawnState.outcome.error)
				return
			}
			;(listeners.get("close") as CloseListener | undefined)?.(
				spawnState.outcome.code,
				spawnState.outcome.signal ?? null,
			)
		})
		return {
			once: (event: string, listener: (...cbArgs: never[]) => void) => {
				listeners.set(event, listener)
			},
		}
	}),
)

vi.mock("child_process", () => ({ default: { spawn }, spawn }))

/** A `fetch` stand-in that answers the releases request with `body`. */
function fetchReturning(body: unknown, ok = true, status = 200): typeof fetch {
	return (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch
}

describe("compareVersions input guards", () => {
	it.each(["", "   ", "v", "cli-v", "-rc1", "+build"])("refuses %j as a version", (version) => {
		expect(() => compareVersions(version, "1.0.0")).toThrow(`Invalid version: ${version}`)
		expect(() => compareVersions("1.0.0", version)).toThrow(`Invalid version: ${version}`)
	})

	it("refuses a version whose parts are not all numeric", () => {
		expect(() => compareVersions("1.x.3", "1.0.0")).toThrow("Invalid version: 1.x.3")
	})
})

describe("getLatestCliVersion", () => {
	it("picks the highest cli-v tag and ignores everything else", async () => {
		const latest = await getLatestCliVersion(
			fetchReturning([
				{ tag_name: "v9.9.9" },
				{ tag_name: "cli-v0.3.0" },
				{ tag_name: "cli-v0.10.0" },
				{ tag_name: "cli-v0.4.0" },
				"not-an-object",
				{ tag_name: 42 },
				{},
			]),
		)

		expect(latest).toBe("0.10.0")
	})

	it("skips a malformed cli tag once a good one has been seen", async () => {
		const latest = await getLatestCliVersion(
			fetchReturning([{ tag_name: "cli-v1.2.3" }, { tag_name: "cli-vnot.a.version" }]),
		)

		expect(latest).toBe("1.2.3")
	})

	it("DEFECT: a malformed cli tag seen FIRST is accepted as the latest version", async () => {
		// `compareVersions` — the only thing that validates a candidate — is
		// skipped for the first tag (`!latestVersion ||`), so a junk tag becomes
		// `latestVersion` and every later, valid tag is discarded by the catch.
		// `upgrade()` then calls `compareVersions(latest, current)` on it and dies
		// with `Invalid version: not.a.version`. Pinned as current behaviour, not
		// as intent.
		const latest = await getLatestCliVersion(
			fetchReturning([{ tag_name: "cli-vnot.a.version" }, { tag_name: "cli-v1.2.3" }]),
		)

		expect(latest).toBe("not.a.version")
	})

	it("refuses a non-array response", async () => {
		await expect(getLatestCliVersion(fetchReturning({ message: "rate limited" }))).rejects.toThrow(
			"Invalid release response from GitHub.",
		)
	})

	it("refuses when no release carries a cli-v tag", async () => {
		await expect(getLatestCliVersion(fetchReturning([{ tag_name: "v1.0.0" }]))).rejects.toThrow(
			"Could not determine the latest CLI release version.",
		)
	})

	it("reports the HTTP status when the release request fails", async () => {
		await expect(getLatestCliVersion(fetchReturning([], false, 403))).rejects.toThrow(
			"Failed to check latest version (HTTP 403)",
		)
	})
})

describe("runUpgradeInstaller", () => {
	beforeEach(() => {
		spawnState.calls = []
		spawnState.outcome = { kind: "close", code: 0 }
		spawn.mockClear()
	})

	it("runs the published install script through sh", async () => {
		await expect(runUpgradeInstaller(undefined, spawn as never)).resolves.toBeUndefined()

		expect(spawnState.calls[0]!.command).toBe("sh")
		expect(spawnState.calls[0]!.args).toEqual(["-c", INSTALL_SCRIPT_COMMAND])
		expect(spawnState.calls[0]!.options).toMatchObject({ stdio: "inherit" })
	})

	it("pins SHOFER_VERSION when a version is requested", async () => {
		await runUpgradeInstaller("1.2.3", spawn as never)

		const env = spawnState.calls[0]!.options.env as Record<string, string>
		expect(env.SHOFER_VERSION).toBe("1.2.3")
	})

	it("leaves the environment untouched when no version is requested", async () => {
		await runUpgradeInstaller(undefined, spawn as never)

		expect(spawnState.calls[0]!.options.env).toBe(process.env)
	})

	it("reports a non-zero exit code", async () => {
		spawnState.outcome = { kind: "close", code: 3 }
		await expect(runUpgradeInstaller(undefined, spawn as never)).rejects.toThrow(
			"Upgrade installer failed (exit code 3).",
		)
	})

	it("reports a signal kill", async () => {
		spawnState.outcome = { kind: "close", code: null, signal: "SIGKILL" }
		await expect(runUpgradeInstaller(undefined, spawn as never)).rejects.toThrow(
			"Upgrade installer failed (signal SIGKILL).",
		)
	})

	it("reports an unknown termination", async () => {
		spawnState.outcome = { kind: "close", code: null }
		await expect(runUpgradeInstaller(undefined, spawn as never)).rejects.toThrow(
			"Upgrade installer failed (exit code unknown).",
		)
	})

	it("propagates a spawn failure", async () => {
		spawnState.outcome = { kind: "error", error: new Error("sh: not found") }
		await expect(runUpgradeInstaller(undefined, spawn as never)).rejects.toThrow("sh: not found")
	})
})

describe("upgrade", () => {
	beforeEach(() => {
		spawnState.calls = []
		spawnState.outcome = { kind: "close", code: 0 }
		spawn.mockClear()
		vi.spyOn(console, "log").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("falls back to the real installer when none is injected", async () => {
		await upgrade({
			currentVersion: "0.1.0",
			fetchImpl: fetchReturning([{ tag_name: "cli-v0.2.0" }]),
		})

		expect(spawn).toHaveBeenCalledTimes(1)
		expect((spawnState.calls[0]!.options.env as Record<string, string>).SHOFER_VERSION).toBe("0.2.0")
	})

	it("does not touch the installer when already current", async () => {
		await upgrade({
			currentVersion: "0.2.0",
			fetchImpl: fetchReturning([{ tag_name: "cli-v0.2.0" }]),
		})

		expect(spawn).not.toHaveBeenCalled()
	})
})
