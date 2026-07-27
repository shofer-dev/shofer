// Host-shared `@shofer/plugin-ui` shim (design §6.8) — the component-kit counterpart of
// `react.js`.
//
// A plugin's UI bundle is built with `@shofer/plugin-ui` **externalized**, so its
// `import { Button, usePluginTranslation } from "@shofer/plugin-ui"` stays a bare
// specifier. The webview's import map resolves it to THIS module, which re-exports the
// host's already-running kit (published on the global by `webview-ui/src/index.tsx`).
// Sharing the real components — rather than a plugin hand-rolling look-alikes — is what
// keeps a plugin's UI indistinguishable from a built-in one, and keeps it current when
// the host kit changes.
//
// Served verbatim from `public/` (never transformed), so it must be plain ESM, and every
// export here must exist in `webview-ui/src/plugin-ui/index.ts`.
const NS = globalThis.__shoferPluginUi

export const Badge = NS.Badge
export const Button = NS.Button
export const Checkbox = NS.Checkbox
export const Collapsible = NS.Collapsible
export const CollapsibleContent = NS.CollapsibleContent
export const CollapsibleTrigger = NS.CollapsibleTrigger
export const Dialog = NS.Dialog
export const DialogContent = NS.DialogContent
export const DialogDescription = NS.DialogDescription
export const DialogFooter = NS.DialogFooter
export const DialogHeader = NS.DialogHeader
export const DialogTitle = NS.DialogTitle
export const Input = NS.Input
export const Popover = NS.Popover
export const PopoverContent = NS.PopoverContent
export const PopoverTrigger = NS.PopoverTrigger
export const Progress = NS.Progress
export const SearchableSelect = NS.SearchableSelect
export const Separator = NS.Separator
export const StandardTooltip = NS.StandardTooltip
export const Textarea = NS.Textarea
export const ToggleSwitch = NS.ToggleSwitch
export const useShoferPortal = NS.useShoferPortal
export const cn = NS.cn
export const usePluginTranslation = NS.usePluginTranslation
