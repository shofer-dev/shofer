// Compiled UI bundle for a crashing external plugin (P4 external UI). Throws while
// rendering so the test can prove PluginSlot's error boundary isolates an external
// bundle just like a co-bundled one. Built shape: bare `react/jsx-runtime` external.
import { jsx as _jsx } from "react/jsx-runtime"

export default function CrashingExternal() {
	throw new Error("boom from external plugin UI")
	// eslint-disable-next-line no-unreachable
	return _jsx("div", { children: "never" })
}
