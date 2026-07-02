import { getHost } from "@shofer/types"

/**
 * App/build identity, host-provided (previously read from the extension's `package.json`
 * + `PKG_*` env in `src/shared/package.ts`). Lazy getters so a consumer's `Package.name`
 * resolves against the active host at call time — the VS Code adapter supplies the real
 * values via `getHost().env.appInfo`; the in-memory host supplies defaults.
 */
export const Package = {
	get publisher() {
		return getHost().env.appInfo.publisher
	},
	get name() {
		return getHost().env.appInfo.name
	},
	get version() {
		return getHost().env.appInfo.version
	},
	get outputChannel() {
		return getHost().env.appInfo.outputChannel
	},
	get sha() {
		return getHost().env.appInfo.sha
	},
	get changelog() {
		return getHost().env.appInfo.changelog
	},
}
