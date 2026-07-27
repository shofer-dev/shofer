import { createContext } from "react"

/**
 * Which plugin the surrounding UI mount belongs to.
 *
 * Provided by {@link PluginSlot} around every plugin component it renders, and read by
 * the `@shofer/plugin-ui` hooks a plugin bundle calls — `usePluginTranslation` needs to
 * know whose catalogue to read, and asking the component to pass its own name would be
 * one more thing to get wrong (and to spoof).
 *
 * It works across the host↔bundle boundary for the same reason hooks do: the bundle
 * imports the host's React instance, so it sees the host's context.
 */
export const PluginUiMountContext = createContext<{ pluginName?: string }>({})
