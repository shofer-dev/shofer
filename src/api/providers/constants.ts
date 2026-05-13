import { Package } from "../../shared/package"

export const DEFAULT_HEADERS = {
	"HTTP-Referer": "https://github.com/shofer-dev/shofer",
	"X-Title": "Shofer",
	"User-Agent": `Shofer/${Package.version}`,
}
