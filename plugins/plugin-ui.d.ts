/**
 * `@shofer/plugin-ui` — the host component kit, as seen by a plugin's UI bundle.
 *
 * At runtime a plugin gets the host's **real** components: its bundle externalizes this
 * specifier and the webview's import map resolves it to the running kit
 * (`webview-ui/src/plugin-ui/index.ts` → `public/plugin-host/plugin-ui.js`). This file is
 * only the type side of that contract, kept here rather than generated from the webview
 * so a plugin can be typechecked on its own — plugins live outside every package's tsc
 * root, and pulling the webview's source (and its `@/` aliases, vite types and stricter
 * flags) into each plugin's project is worse than declaring the surface once.
 *
 * Drift is not left to review: `webview-ui/src/plugin-ui/__tests__/plugin-ui-shim.spec.ts`
 * fails when this declaration, the kit module and the served shim stop agreeing on which
 * names exist.
 *
 * Props are declared as far as a plugin needs them — the visual variants and the
 * behaviour it drives — not as a mirror of every internal prop.
 */

declare module "@shofer/plugin-ui" {
	import type { ComponentType, ForwardRefExoticComponent, ReactNode, RefAttributes } from "react"

	// ─── Utilities ──────────────────────────────────────────────────────────────

	/** Tailwind-aware class merge (the same helper the host components use). */
	export function cn(...inputs: unknown[]): string

	/** Translate a key from the calling plugin's own `locales/<lang>.json`. */
	export type PluginTranslate = (key: string, options?: Record<string, unknown>) => string

	/**
	 * Translations for the plugin whose slot this component renders in. Interpolation
	 * (`{{name}}`), plurals (`count`) and language switching come from the host's i18next.
	 */
	export function usePluginTranslation(): PluginTranslate

	/** Container element overlays portal into, so they escape the mount's stacking context. */
	export function useShoferPortal(): HTMLElement | undefined

	// ─── Controls ───────────────────────────────────────────────────────────────

	export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
		variant?: "primary" | "secondary" | "ghost" | "destructive" | "outline" | "link" | "combobox"
		size?: "default" | "sm" | "lg" | "icon"
		/** Render the single child element instead of a `<button>`, keeping the styling. */
		asChild?: boolean
	}
	export const Button: ForwardRefExoticComponent<ButtonProps & RefAttributes<HTMLButtonElement>>

	export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
		variant?: "default" | "secondary" | "destructive" | "outline"
	}
	export const Badge: ComponentType<BadgeProps>

	export interface CheckboxProps {
		checked?: boolean
		defaultChecked?: boolean
		disabled?: boolean
		onCheckedChange?: (checked: boolean) => void
		className?: string
		children?: ReactNode
	}
	export const Checkbox: ComponentType<CheckboxProps>

	export const Input: ForwardRefExoticComponent<
		React.InputHTMLAttributes<HTMLInputElement> & RefAttributes<HTMLInputElement>
	>
	export const Textarea: ForwardRefExoticComponent<
		React.TextareaHTMLAttributes<HTMLTextAreaElement> & RefAttributes<HTMLTextAreaElement>
	>

	export interface ToggleSwitchProps {
		checked: boolean
		onChange: (checked: boolean) => void
		disabled?: boolean
		size?: "small" | "medium" | "large"
		className?: string
		"aria-label"?: string
	}
	export const ToggleSwitch: ComponentType<ToggleSwitchProps>

	export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
		/** 0–100. */
		value?: number
	}
	export const Progress: ComponentType<ProgressProps>

	export const Separator: ComponentType<
		React.HTMLAttributes<HTMLDivElement> & { orientation?: "horizontal" | "vertical" }
	>

	// ─── Overlays ───────────────────────────────────────────────────────────────

	export interface StandardTooltipProps {
		children: ReactNode
		content: ReactNode
		side?: "top" | "right" | "bottom" | "left"
		align?: "start" | "center" | "end"
		sideOffset?: number
		className?: string
	}
	export const StandardTooltip: ComponentType<StandardTooltipProps>

	export interface OpenChangeProps {
		open?: boolean
		defaultOpen?: boolean
		onOpenChange?: (open: boolean) => void
		children?: ReactNode
	}

	export const Popover: ComponentType<OpenChangeProps & { modal?: boolean }>
	export const PopoverTrigger: ComponentType<{ asChild?: boolean; children?: ReactNode; className?: string }>
	export const PopoverContent: ComponentType<
		React.HTMLAttributes<HTMLDivElement> & {
			align?: "start" | "center" | "end"
			side?: "top" | "right" | "bottom" | "left"
			sideOffset?: number
			container?: HTMLElement | null
		}
	>

	export const Dialog: ComponentType<OpenChangeProps & { modal?: boolean }>
	export const DialogContent: ComponentType<React.HTMLAttributes<HTMLDivElement> & { container?: HTMLElement | null }>
	export const DialogHeader: ComponentType<React.HTMLAttributes<HTMLDivElement>>
	export const DialogFooter: ComponentType<React.HTMLAttributes<HTMLDivElement>>
	export const DialogTitle: ComponentType<React.HTMLAttributes<HTMLHeadingElement>>
	export const DialogDescription: ComponentType<React.HTMLAttributes<HTMLParagraphElement>>

	export const Collapsible: ComponentType<OpenChangeProps & { className?: string }>
	export const CollapsibleTrigger: ComponentType<{ asChild?: boolean; children?: ReactNode; className?: string }>
	export const CollapsibleContent: ComponentType<React.HTMLAttributes<HTMLDivElement>>

	// ─── Composite ──────────────────────────────────────────────────────────────

	export interface SearchableSelectOption {
		value: string
		label: string
		disabled?: boolean
	}

	export interface SearchableSelectProps {
		value?: string
		options: SearchableSelectOption[]
		onValueChange: (value: string) => void
		placeholder?: string
		searchPlaceholder?: string
		emptyMessage?: string
		disabled?: boolean
		className?: string
	}
	export const SearchableSelect: ComponentType<SearchableSelectProps>
}
