import * as fs from "node:fs/promises"

import * as vscode from "vscode"
import type { HostBridge, HostFileSystem, Notifier } from "@shofer/types"
import { createInMemoryHost } from "@shofer/types"

/**
 * VS Code-backed implementation of the host boundary (§9). This is the extension
 * adapter for `HostBridge` — the only place the core's host-service needs touch
 * `vscode.*` / Node `fs`. As call sites migrate from direct `vscode.*` usage onto
 * `getHost()`, this adapter (and the CLI's in-memory one) become the sole host
 * couplings, leaving the core `vscode`-free.
 */

class VsCodeNotifier implements Notifier {
	info(message: string): void {
		void vscode.window.showInformationMessage(message)
	}
	warn(message: string): void {
		void vscode.window.showWarningMessage(message)
	}
	error(message: string): void {
		void vscode.window.showErrorMessage(message)
	}
	showChoice(message: string, options: string[]): Promise<string | undefined> {
		return Promise.resolve(vscode.window.showInformationMessage(message, ...options))
	}
}

class NodeFileSystem implements HostFileSystem {
	readFile(path: string): Promise<string> {
		return fs.readFile(path, "utf8")
	}
	writeFile(path: string, content: string): Promise<void> {
		return fs.writeFile(path, content, "utf8")
	}
	async exists(path: string): Promise<boolean> {
		try {
			await fs.access(path)
			return true
		} catch {
			return false
		}
	}
	async mkdir(path: string): Promise<void> {
		await fs.mkdir(path, { recursive: true })
	}
	delete(path: string): Promise<void> {
		return fs.rm(path, { recursive: true, force: true })
	}
}

/** The VS Code host bridge (extension runtime). */
export function createVsCodeHost(): HostBridge {
	return { notifier: new VsCodeNotifier(), fs: new NodeFileSystem() }
}

// Module-level host accessor. Defaults to an in-memory host so call sites work in
// tests / before activation; the extension installs the VS Code host on activate.
let host: HostBridge = createInMemoryHost()

/** Install the active host bridge (call once at activation). */
export function setHost(bridge: HostBridge): void {
	host = bridge
}

/** The active host bridge. */
export function getHost(): HostBridge {
	return host
}
