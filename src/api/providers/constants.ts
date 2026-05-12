import { Package } from "../../shared/package"

export const DEFAULT_HEADERS = {
	"HTTP-Referer": "https://github.com/alsterg/shofer.dev",
	"X-Title": "Shofer",
	"User-Agent": `Shofer/${Package.version}`,
}
