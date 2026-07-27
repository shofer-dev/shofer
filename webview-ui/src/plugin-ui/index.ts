/**
 * `@shofer/plugin-ui` — the component surface a plugin's UI bundle may use.
 *
 * A plugin bundle already shares the host's **React** (via the `plugin-host/react.js`
 * shim and the webview's import map). This module extends that boundary to the host's
 * **components and translations**, for the same reason: a plugin that hand-rolls a
 * dialog or a popover ends up with something that looks almost-right, behaves
 * differently under keyboard and focus, and drifts from the product every time the host
 * kit changes. Sharing the real components makes a plugin's UI indistinguishable from a
 * built-in one — which is the point, because the features that ship as bundled plugins
 * *are* Shofer.
 *
 * How it reaches a plugin (mirroring the React shim exactly):
 *
 * 1. `webview-ui/src/index.tsx` publishes this module on `globalThis.__shoferPluginUi`.
 * 2. `webview-ui/public/plugin-host/plugin-ui.js` re-exports those globals as plain ESM.
 * 3. The webview's import map resolves the bare specifier `@shofer/plugin-ui` to that
 *    shim (`pluginHostImportMap.ts`, and the HMR variant in `ShoferProvider`).
 * 4. A plugin's build externalizes `@shofer/plugin-ui`, and its tsconfig maps the
 *    specifier here for typechecking.
 *
 * **This list is a contract.** Every export is something a plugin may rely on, so add
 * deliberately and do not remove without treating it as a breaking change. Styling needs
 * nothing extra: the components render inside the host document, so the host's CSS
 * (including its VS Code theme variables) already applies.
 *
 * Icons are deliberately NOT re-exported — `lucide-react` is a plain dependency a plugin
 * can bundle itself, and it renders through the shared React like any other component.
 */

export {
	Badge,
	Button,
	Checkbox,
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Progress,
	SearchableSelect,
	Separator,
	StandardTooltip,
	Textarea,
	ToggleSwitch,
} from "@/components/ui"
export type { SearchableSelectOption } from "@/components/ui"

/** Portal container for overlays, so a popover/dialog escapes its mount's stacking context. */
export { useShoferPortal } from "@/components/ui/hooks/useShoferPortal"

/** Tailwind class merge helper — the same one the host components use internally. */
export { cn } from "@/lib/utils"

export { usePluginTranslation } from "./usePluginTranslation"
export type { PluginTranslate } from "./usePluginTranslation"
