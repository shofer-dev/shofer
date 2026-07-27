// ui/status.tsx
import { useCallback, useEffect, useState } from "react";
import { StandardTooltip, cn, usePluginTranslation } from "@shofer/plugin-ui";
import { jsx } from "react/jsx-runtime";
var GLYPH = {
  Indexed: { icon: "codicon-database", tone: "text-vscode-charts-green" },
  Indexing: { icon: "codicon-sync codicon-modifier-spin", tone: "text-vscode-charts-blue" },
  Error: { icon: "codicon-error", tone: "text-vscode-errorForeground" },
  Standby: { icon: "codicon-database", tone: "text-vscode-descriptionForeground" }
};
var POLL_MS = 3e3;
function IndexingStatusChip({ api }) {
  const t = usePluginTranslation();
  const [status, setStatus] = useState(null);
  const refresh = useCallback(() => {
    void api.request("local:status").then((reply) => setStatus(reply?.code ?? null)).catch(() => setStatus(null));
  }, [api]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  if (!status || status.systemStatus === "Disabled") return null;
  const glyph = GLYPH[status.systemStatus] ?? GLYPH.Standby;
  const detail = status.systemStatus === "Indexing" && status.totalItems ? t("chip.indexing", { processed: status.processedItems ?? 0, total: status.totalItems }) : status.message ?? t(`chip.${status.systemStatus.toLowerCase()}`);
  return /* @__PURE__ */ jsx(StandardTooltip, { content: detail, children: /* @__PURE__ */ jsx(
    "span",
    {
      className: cn("inline-flex items-center px-1 py-1 text-xs opacity-90", glyph.tone),
      "aria-label": t("chip.aria", { state: status.systemStatus }),
      children: /* @__PURE__ */ jsx("span", { className: cn("codicon", glyph.icon) })
    }
  ) });
}
export {
  IndexingStatusChip as default
};
