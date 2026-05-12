import type { ExtensionContext } from "vscode"

export function getUserAgent(context?: ExtensionContext): string {
	return `Shofer ${context?.extension?.packageJSON?.version || "unknown"}`
}
