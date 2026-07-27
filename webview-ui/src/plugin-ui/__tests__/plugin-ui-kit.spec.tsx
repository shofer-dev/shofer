import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { render, screen } from "@/utils/test-utils"

import { PluginUiMountContext } from "@/components/plugins/PluginUiMountContext"
import { loadPluginTranslations } from "@/i18n/setup"

import { Button, usePluginTranslation } from "../index"

/**
 * The kit as a plugin's UI actually uses it: host components plus the plugin's own
 * catalogue, with the plugin identified by the mount rather than by the component.
 *
 * The component below stands in for a plugin bundle — the real bundles cannot be
 * imported here, because their `react` is externalized and resolves outside this
 * package, and a second React instance breaks every context in the worker. Their
 * integrity is covered elsewhere: esbuild fails on an unresolvable import,
 * `plugin-ui-shim.spec.ts` pins the exported surface, and `PluginSlot.external.spec.tsx`
 * pins the load-and-mount path. The strings used here are a real plugin's
 * (`plugins/file-changes/locales/en.json`), so a key renamed there fails this spec.
 */

const PLUGIN = "file-changes"
const locales = JSON.parse(readFileSync(resolve(process.cwd(), "../plugins/file-changes/locales/en.json"), "utf8"))

/** A stand-in for a plugin's UI bundle: kit components + `usePluginTranslation`. */
function PluginComponent({ count }: { count: number }) {
	const t = usePluginTranslation()
	return (
		<div>
			<span>{t("panel.header", { count })}</span>
			<Button variant="ghost" size="icon" aria-label={t("panel.acceptAll")}>
				<span className="codicon codicon-check-all" />
			</Button>
		</div>
	)
}

function renderIn(pluginName: string | undefined, count = 2) {
	return render(
		<PluginUiMountContext.Provider value={{ pluginName }}>
			<PluginComponent count={count} />
		</PluginUiMountContext.Provider>,
	)
}

describe("@shofer/plugin-ui, as a plugin uses it", () => {
	beforeEach(() => {
		loadPluginTranslations([{ pluginName: PLUGIN, resources: { en: locales } }])
	})

	it("resolves the calling plugin's own strings, with interpolation and plurals", () => {
		renderIn(PLUGIN, 2)
		expect(screen.getByText("2 files changed")).toBeInTheDocument()
	})

	it("selects the singular form for one item", () => {
		renderIn(PLUGIN, 1)
		expect(screen.getByText("1 file changed")).toBeInTheDocument()
	})

	it("renders the host's Button, not a look-alike", () => {
		renderIn(PLUGIN)
		const button = screen.getByLabelText("Accept all")
		expect(button.tagName).toBe("BUTTON")
		// The kit's Button carries the host's variant classes; an inline-styled button
		// would not.
		expect(button.className).toContain("inline-flex")
	})

	it("renders the key for a plugin that ships no translations at all", () => {
		// A plugin with no `locales/` directory contributes no namespace; its UI shows the
		// keys — visible rather than silently blank, which is the failure mode a plugin
		// author can actually see.
		renderIn("a-plugin-with-no-locales")
		expect(screen.getByText("panel.header")).toBeInTheDocument()
	})

	it("renders the key outside a plugin mount, rather than another plugin's string", () => {
		renderIn(undefined)
		expect(screen.getByText("panel.header")).toBeInTheDocument()
	})
})
