/**
 * The plugin's backend translations — the `embeddings:` namespace that used to live in
 * core's i18n.
 *
 * These are the strings a user actually reads when indexing goes wrong ("Ollama is not
 * running", "the collection's vector size does not match the model"), in eighteen
 * languages. They came with the feature when it left core, so the plugin carries them
 * rather than depending on a host namespace that would exist only for it.
 *
 * A deliberately small i18next-lookalike instead of i18next itself: the call sites want
 * `t("embeddings:key.path", { interpolated })` and nothing else — no plurals, no
 * formatters, no lazy loading. Every locale is imported statically so the bundle carries
 * them and nothing has to find a JSON file at runtime.
 */

import ca from "../locales/backend/ca.json" with { type: "json" }
import de from "../locales/backend/de.json" with { type: "json" }
import en from "../locales/backend/en.json" with { type: "json" }
import es from "../locales/backend/es.json" with { type: "json" }
import fr from "../locales/backend/fr.json" with { type: "json" }
import hi from "../locales/backend/hi.json" with { type: "json" }
import id from "../locales/backend/id.json" with { type: "json" }
import it from "../locales/backend/it.json" with { type: "json" }
import ja from "../locales/backend/ja.json" with { type: "json" }
import ko from "../locales/backend/ko.json" with { type: "json" }
import nl from "../locales/backend/nl.json" with { type: "json" }
import pl from "../locales/backend/pl.json" with { type: "json" }
import ptBR from "../locales/backend/pt-BR.json" with { type: "json" }
import ru from "../locales/backend/ru.json" with { type: "json" }
import tr from "../locales/backend/tr.json" with { type: "json" }
import vi from "../locales/backend/vi.json" with { type: "json" }
import zhCN from "../locales/backend/zh-CN.json" with { type: "json" }
import zhTW from "../locales/backend/zh-TW.json" with { type: "json" }

type Bundle = Record<string, unknown>

const BUNDLES: Record<string, Bundle> = {
	ca,
	de,
	en,
	es,
	fr,
	hi,
	id,
	it,
	ja,
	ko,
	nl,
	pl,
	"pt-BR": ptBR,
	ru,
	tr,
	vi,
	"zh-CN": zhCN,
	"zh-TW": zhTW,
}

let language = "en"

/** Follow the host's display language (`ctx.host.env.language`), e.g. `"pt-BR"`, `"de"`. */
export function setLanguage(next: string | undefined): void {
	if (!next) return
	// A host may report a regional tag we have no bundle for ("de-AT"); fall back to its
	// base language before giving up on English.
	language = BUNDLES[next] ? next : BUNDLES[next.split("-")[0]!] ? next.split("-")[0]! : "en"
}

function lookup(bundle: Bundle | undefined, path: string[]): string | undefined {
	let node: unknown = bundle
	for (const segment of path) {
		if (!node || typeof node !== "object") return undefined
		node = (node as Record<string, unknown>)[segment]
	}
	return typeof node === "string" ? node : undefined
}

/**
 * Translate `"embeddings:some.key"` with `{{name}}` interpolation.
 *
 * Falls back to English, then to the key itself — a missing translation must never
 * replace an error message with an empty string, which is how a failure becomes
 * undiagnosable.
 */
export function t(key: string, options?: Record<string, unknown>): string {
	const [namespace, rest] = key.includes(":") ? key.split(":") : ["embeddings", key]
	if (namespace !== "embeddings") return key
	const path = (rest ?? "").split(".")
	const template = lookup(BUNDLES[language], path) ?? lookup(BUNDLES.en, path)
	if (template === undefined) return key
	if (!options) return template
	return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
		options[name] === undefined ? match : String(options[name]),
	)
}
