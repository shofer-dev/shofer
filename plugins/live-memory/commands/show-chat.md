---
description: Open / focus the Live Memory chat panel to watch the memory agent's live conversation and state.
---

Open the **Live Memory** chat panel (the `live-memory` plugin's sidebar panel) to
watch the persistent memory agent work in real time: its state header
(Standby / Ready / Busy / Error), context-window usage, and the streaming typed
conversation (text, reasoning, and tool-call parts with a running → done
transition).

The panel is the plugin analogue of the built-in `liveMemory.showChat` command. If
the panel is already open, it is revealed/focused rather than duplicated. From the
panel you can also **Clear context** or **Empty memory** (see `/live-memory:empty`).

No action is required from the model here — this command is a human affordance for
opening the panel. To actually query Live Memory, use the `ask_live_memory` tool.
