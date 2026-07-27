// ui/row.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  StandardTooltip,
  cn,
  usePluginTranslation
} from "@shofer/plugin-ui";
import { jsx, jsxs } from "react/jsx-runtime";
var ACCENT = "rgba(0, 188, 255, .65)";
function CheckpointRow({ api }) {
  const t = usePluginTranslation();
  const marker = api.context.message;
  const [hovering, setHovering] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState();
  const statusTimer = useRef(null);
  useEffect(
    () => () => {
      if (statusTimer.current) window.clearTimeout(statusTimer.current);
    },
    []
  );
  const flash = useCallback((text) => {
    setStatus(text);
    if (statusTimer.current) window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(() => setStatus(void 0), 4e3);
  }, []);
  const showDiff = useCallback(
    async (mode) => {
      if (!marker?.text) return;
      setMoreOpen(false);
      try {
        const result = await api.request("diff", { commitHash: marker.text, mode });
        if (result?.notice) {
          flash(t(`notice.${result.notice}`));
          return;
        }
        await api.request("local:show-diff", { title: result.title, changes: result.changes });
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error));
      }
    },
    [api, marker?.text, flash, t]
  );
  const restore = useCallback(
    async (mode) => {
      if (!marker?.text) return;
      setRestoreOpen(false);
      setConfirming(false);
      try {
        await api.request("restore", { ts: marker.ts, commitHash: marker.text, mode }, { mutates: true });
      } catch (error) {
        flash(error instanceof Error ? error.message : String(error));
      }
    },
    [api, marker?.ts, marker?.text, flash]
  );
  if (!marker?.text) return null;
  const menuVisible = hovering || restoreOpen || moreOpen;
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: "flex flex-col gap-0.5 pt-2 pb-3",
      onMouseEnter: () => setHovering(true),
      onMouseLeave: () => setHovering(false),
      children: [
        /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
          /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-1.5 whitespace-nowrap text-vscode-charts-blue", children: [
            /* @__PURE__ */ jsx("span", { className: "codicon codicon-git-commit" }),
            /* @__PURE__ */ jsx("span", { className: "font-semibold", children: t("row.label") })
          ] }),
          /* @__PURE__ */ jsx(
            "span",
            {
              className: "flex-1 h-0.5 mt-0.5",
              style: {
                backgroundImage: `linear-gradient(90deg, ${ACCENT}, ${ACCENT} 80%, rgba(0, 188, 255, 0) 99%)`
              }
            }
          ),
          /* @__PURE__ */ jsxs("div", { className: cn("flex gap-0.5", menuVisible ? "visible" : "invisible"), children: [
            /* @__PURE__ */ jsx(StandardTooltip, { content: t("row.diffTooltip"), children: /* @__PURE__ */ jsx(
              Button,
              {
                variant: "ghost",
                size: "icon",
                "aria-label": t("row.diff"),
                onClick: () => void showDiff("checkpoint"),
                children: /* @__PURE__ */ jsx("span", { className: "codicon codicon-diff-single" })
              }
            ) }),
            /* @__PURE__ */ jsxs(
              Popover,
              {
                open: restoreOpen,
                onOpenChange: (open) => {
                  setRestoreOpen(open);
                  if (!open) setConfirming(false);
                },
                children: [
                  /* @__PURE__ */ jsx(StandardTooltip, { content: t("row.restore"), children: /* @__PURE__ */ jsx(PopoverTrigger, { asChild: true, children: /* @__PURE__ */ jsx(Button, { variant: "ghost", size: "icon", "aria-label": t("row.restore"), children: /* @__PURE__ */ jsx("span", { className: "codicon codicon-history" }) }) }) }),
                  /* @__PURE__ */ jsxs(PopoverContent, { align: "end", className: "flex flex-col gap-3 w-72", children: [
                    /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-1", children: [
                      /* @__PURE__ */ jsx(Button, { variant: "secondary", onClick: () => void restore("preview"), children: t("restore.filesOnly") }),
                      /* @__PURE__ */ jsx("div", { className: "text-vscode-descriptionForeground text-sm", children: t("restore.filesOnlyHint") })
                    ] }),
                    /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-1", children: [
                      !confirming ? /* @__PURE__ */ jsx(Button, { variant: "secondary", onClick: () => setConfirming(true), children: t("restore.filesAndTask") }) : /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-1", children: [
                        /* @__PURE__ */ jsx(Button, { variant: "primary", onClick: () => void restore("restore"), children: t("restore.confirm") }),
                        /* @__PURE__ */ jsx(Button, { variant: "secondary", onClick: () => setConfirming(false), children: t("restore.cancel") })
                      ] }),
                      /* @__PURE__ */ jsx(
                        "div",
                        {
                          className: cn(
                            "text-sm",
                            confirming ? "text-vscode-errorForeground font-bold" : "text-vscode-descriptionForeground"
                          ),
                          children: confirming ? t("restore.irreversible") : t("restore.filesAndTaskHint")
                        }
                      )
                    ] })
                  ] })
                ]
              }
            ),
            /* @__PURE__ */ jsxs(Popover, { open: moreOpen, onOpenChange: setMoreOpen, children: [
              /* @__PURE__ */ jsx(StandardTooltip, { content: t("row.more"), children: /* @__PURE__ */ jsx(PopoverTrigger, { asChild: true, children: /* @__PURE__ */ jsx(Button, { variant: "ghost", size: "icon", "aria-label": t("row.more"), children: /* @__PURE__ */ jsx("span", { className: "codicon codicon-kebab-vertical" }) }) }) }),
              /* @__PURE__ */ jsxs(PopoverContent, { align: "end", className: "flex flex-col gap-1 w-72", children: [
                /* @__PURE__ */ jsxs(Button, { variant: "ghost", className: "justify-start", onClick: () => void showDiff("from-init"), children: [
                  /* @__PURE__ */ jsx("span", { className: "codicon codicon-versions" }),
                  t("more.sinceFirst")
                ] }),
                /* @__PURE__ */ jsxs(
                  Button,
                  {
                    variant: "ghost",
                    className: "justify-start",
                    onClick: () => void showDiff("to-current"),
                    children: [
                      /* @__PURE__ */ jsx("span", { className: "codicon codicon-diff" }),
                      t("more.againstCurrent")
                    ]
                  }
                )
              ] })
            ] })
          ] })
        ] }),
        status && /* @__PURE__ */ jsx("div", { className: "text-sm text-vscode-descriptionForeground", children: status })
      ]
    }
  );
}
export {
  CheckpointRow as default
};
