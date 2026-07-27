// ui/settings.tsx
import { useCallback as useCallback2, useEffect as useEffect2, useState as useState2 } from "react";
import { Badge, Button as Button2, StandardTooltip, cn, usePluginTranslation as usePluginTranslation2 } from "@shofer/plugin-ui";

// ui/shared.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  SearchableSelect,
  usePluginTranslation
} from "@shofer/plugin-ui";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
function ask(api, method, params, mutates = false) {
  return api.request(`local:${method}`, params, { mutates });
}
function formatBytes(bytes) {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1e3 && unit < units.length - 1) {
    value /= 1e3;
    unit++;
  }
  return `${unit === 0 ? value : value.toPrecision(3)} ${units[unit]}`;
}
function worktreeLabel(worktree, t) {
  if (worktree.branch) return worktree.branch;
  return worktree.isDetached ? t("view.detachedHead") : t("view.noBranch");
}
function useCreationProgress(api) {
  const [steps, setSteps] = useState([]);
  const [copy, setCopy] = useState(null);
  useEffect(
    () => api.onMessage((raw) => {
      const message = raw;
      if (message?.type === "worktrees:step") {
        const { name, detail } = message;
        setSteps((previous) => {
          if (detail === "done" || detail === "skipped" || detail?.startsWith("failed")) {
            return previous.map((s) => s.step === name ? { ...s, detail, completed: true } : s);
          }
          return previous.some((s) => s.step === name) ? previous : [...previous, { step: name, detail, completed: false }];
        });
      }
      if (message?.type === "worktrees:copy-progress") {
        setCopy({ bytesCopied: message.bytesCopied ?? 0, itemName: message.itemName ?? "" });
      }
    }),
    [api]
  );
  const reset = useCallback(() => {
    setSteps([]);
    setCopy(null);
  }, []);
  return { steps, copy, reset };
}
function CreateWorktreeDialog({
  api,
  open,
  onClose,
  onCreated
}) {
  const t = usePluginTranslation();
  const { copy, reset } = useCreationProgress(api);
  const [branchName, setBranchName] = useState("");
  const [worktreePath, setWorktreePath] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [defaults, setDefaults] = useState(null);
  const [branches, setBranches] = useState(null);
  const [includeStatus, setIncludeStatus] = useState(null);
  const [conventionPrefix, setConventionPrefix] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState(null);
  const [initSubmodules, setInitSubmodules] = useState(true);
  const [copyWorktreeInclude, setCopyWorktreeInclude] = useState(true);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    reset();
    setError(null);
    void (async () => {
      try {
        const [suggested, available, include] = await Promise.all([
          ask(api, "defaults"),
          ask(api, "branches"),
          ask(api, "include-status")
        ]);
        if (cancelled) return;
        setDefaults(suggested);
        setBranchName(suggested.suggestedBranch);
        setWorktreePath(suggested.suggestedPath);
        const separator = suggested.suggestedPath.includes("\\") ? "\\" : "/";
        const lastSeparator = suggested.suggestedPath.lastIndexOf(separator);
        if (lastSeparator !== -1) setConventionPrefix(suggested.suggestedPath.slice(0, lastSeparator));
        setBranches(available);
        setBaseBranch(available.currentBranch || "main");
        setIncludeStatus(include);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, open, reset]);
  useEffect(() => {
    if (!conventionPrefix || !branchName.trim()) return;
    const next = `${conventionPrefix}/${branchName}`;
    setWorktreePath((current) => current === next ? current : next);
  }, [branchName, conventionPrefix]);
  const handleCreate = useCallback(async () => {
    setError(null);
    setIsCreating(true);
    try {
      const result = await ask(
        api,
        "create",
        {
          path: worktreePath,
          branch: branchName,
          baseBranch,
          createNewBranch: true,
          initSubmodules,
          copyWorktreeInclude
        },
        true
      );
      if (!result.success) {
        setError(result.message || "Unknown error");
        return;
      }
      onCreated?.(result.worktree?.path ?? worktreePath, result.worktree?.branch ?? branchName);
      onClose();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setIsCreating(false);
      reset();
    }
  }, [api, worktreePath, branchName, baseBranch, initSubmodules, copyWorktreeInclude, onCreated, onClose, reset]);
  const branchOptions = branches ? [
    ...branches.localBranches.map((branch) => ({
      value: branch,
      label: branch,
      icon: /* @__PURE__ */ jsx("span", { className: "codicon codicon-git-branch mr-2 text-vscode-descriptionForeground" })
    })),
    ...branches.remoteBranches.map((branch) => ({
      value: branch,
      label: branch,
      icon: /* @__PURE__ */ jsx("span", { className: "codicon codicon-cloud mr-2 text-vscode-descriptionForeground" })
    }))
  ] : [];
  const isValid = Boolean(branchName.trim() && worktreePath.trim() && baseBranch.trim());
  return /* @__PURE__ */ jsx(Dialog, { open, onOpenChange: (isOpen) => !isOpen && onClose(), children: /* @__PURE__ */ jsxs(DialogContent, { className: "max-w-lg z-[60]", overlayClassName: "z-[60]", children: [
    /* @__PURE__ */ jsx(DialogHeader, { children: /* @__PURE__ */ jsx(DialogTitle, { children: t("create.title") }) }),
    /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-3", children: [
      includeStatus?.exists === false && /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2 px-3 py-2 rounded-lg bg-vscode-inputValidation-warningBackground border border-vscode-inputValidation-warningBorder text-sm", children: [
        /* @__PURE__ */ jsx("span", { className: "codicon codicon-info shrink-0" }),
        /* @__PURE__ */ jsxs("span", { className: "text-vscode-foreground", children: [
          /* @__PURE__ */ jsx("span", { className: "font-medium", children: t("create.noIncludeFileWarning") }),
          " \u2014 ",
          /* @__PURE__ */ jsx("span", { className: "text-vscode-descriptionForeground", children: t("create.noIncludeFileHint") })
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-1", children: [
        /* @__PURE__ */ jsx("label", { className: "text-sm text-vscode-foreground", children: t("create.baseBranch") }),
        !branches ? /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2 h-8 px-2 text-sm text-vscode-descriptionForeground", children: [
          /* @__PURE__ */ jsx("span", { className: "codicon codicon-loading codicon-modifier-spin" }),
          /* @__PURE__ */ jsx("span", { children: t("create.loadingBranches") })
        ] }) : /* @__PURE__ */ jsx(
          SearchableSelect,
          {
            value: baseBranch,
            onValueChange: setBaseBranch,
            options: branchOptions,
            placeholder: t("create.selectBranch"),
            searchPlaceholder: t("create.searchBranch"),
            emptyMessage: t("create.noBranchFound")
          }
        )
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
        /* @__PURE__ */ jsx("span", { className: "codicon codicon-arrow-small-right ml-2 shrink-0" }),
        /* @__PURE__ */ jsx("label", { className: "text-sm text-vscode-foreground shrink-0", children: t("create.branchName") }),
        /* @__PURE__ */ jsx(
          Input,
          {
            value: branchName,
            onChange: (e) => setBranchName(e.target.value),
            placeholder: defaults?.suggestedBranch || "worktree/feature-name",
            className: "rounded-full"
          }
        )
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
        /* @__PURE__ */ jsx("span", { className: "codicon codicon-folder ml-2 shrink-0" }),
        /* @__PURE__ */ jsx("label", { className: "text-sm text-vscode-foreground shrink-0", children: t("create.worktreePath") }),
        /* @__PURE__ */ jsx(
          Input,
          {
            value: worktreePath,
            readOnly: true,
            className: "rounded-full flex-1 bg-vscode-input-background opacity-80 cursor-default",
            tabIndex: -1
          }
        )
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-2 ml-8", children: [
        /* @__PURE__ */ jsxs("label", { className: "flex items-center gap-2 cursor-pointer", children: [
          /* @__PURE__ */ jsx(
            Checkbox,
            {
              checked: initSubmodules,
              onCheckedChange: (checked) => setInitSubmodules(checked === true),
              disabled: isCreating
            }
          ),
          /* @__PURE__ */ jsx("span", { className: "text-sm text-vscode-foreground", children: t("create.initSubmodules") })
        ] }),
        /* @__PURE__ */ jsxs("label", { className: "flex items-center gap-2 cursor-pointer", children: [
          /* @__PURE__ */ jsx(
            Checkbox,
            {
              checked: copyWorktreeInclude,
              onCheckedChange: (checked) => setCopyWorktreeInclude(checked === true),
              disabled: isCreating
            }
          ),
          /* @__PURE__ */ jsx("span", { className: "text-sm text-vscode-foreground", children: t("create.copyWorktreeInclude") })
        ] })
      ] }),
      error && /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2 px-3 py-2 rounded-lg bg-vscode-inputValidation-errorBackground border border-vscode-inputValidation-errorBorder text-sm", children: [
        /* @__PURE__ */ jsx("span", { className: "codicon codicon-error text-vscode-errorForeground shrink-0" }),
        /* @__PURE__ */ jsx("p", { className: "text-vscode-errorForeground", children: error })
      ] }),
      copy && /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-2 px-3 py-3 rounded-lg bg-vscode-editor-background border border-vscode-panel-border", children: [
        /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2 text-sm", children: [
          /* @__PURE__ */ jsx("span", { className: "codicon codicon-loading codicon-modifier-spin text-vscode-button-background" }),
          /* @__PURE__ */ jsx("span", { className: "text-vscode-foreground font-medium", children: t("create.copyingFiles") })
        ] }),
        /* @__PURE__ */ jsx("div", { className: "text-xs text-vscode-descriptionForeground truncate", children: t("create.copyingProgress", {
          item: copy.itemName,
          copied: formatBytes(copy.bytesCopied)
        }) })
      ] })
    ] }),
    /* @__PURE__ */ jsxs(DialogFooter, { children: [
      /* @__PURE__ */ jsx(Button, { variant: "secondary", onClick: onClose, disabled: isCreating, children: t("common.cancel") }),
      /* @__PURE__ */ jsx(Button, { variant: "primary", onClick: () => void handleCreate(), disabled: !isValid || isCreating, children: isCreating ? /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("span", { className: "codicon codicon-loading codicon-modifier-spin mr-2" }),
        t("create.creating")
      ] }) : t("create.create") })
    ] })
  ] }) });
}
function DeleteWorktreeDialog({
  api,
  worktree,
  open,
  onClose,
  onDeleted
}) {
  const t = usePluginTranslation();
  const [isDeleting, setIsDeleting] = useState(false);
  const [forceDeleteLocked, setForceDeleteLocked] = useState(false);
  const [error, setError] = useState(null);
  const handleDelete = useCallback(async () => {
    setError(null);
    setIsDeleting(true);
    try {
      const force = worktree.isLocked ? forceDeleteLocked : true;
      const result = await ask(api, "delete", { path: worktree.path, force }, true);
      if (!result.success) {
        setError(result.message || "Unknown error");
        return;
      }
      onDeleted?.();
      onClose();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setIsDeleting(false);
    }
  }, [api, worktree.path, worktree.isLocked, forceDeleteLocked, onDeleted, onClose]);
  return /* @__PURE__ */ jsx(Dialog, { open, onOpenChange: (isOpen) => !isOpen && onClose(), children: /* @__PURE__ */ jsxs(DialogContent, { children: [
    /* @__PURE__ */ jsx(DialogHeader, { children: /* @__PURE__ */ jsx(DialogTitle, { children: t("delete.title") }) }),
    /* @__PURE__ */ jsxs("div", { className: "flex flex-col gap-3 overflow-hidden", children: [
      /* @__PURE__ */ jsxs("div", { className: "flex flex-col p-5 gap-2 cursor-default rounded-xl text-vscode-foreground bg-vscode-input-background", children: [
        /* @__PURE__ */ jsxs("p", { className: "flex items-center gap-2 m-0", children: [
          /* @__PURE__ */ jsx("span", { className: "codicon codicon-git-branch shrink-0" }),
          /* @__PURE__ */ jsx("span", { className: "font-medium truncate", children: worktreeLabel(worktree, t) })
        ] }),
        /* @__PURE__ */ jsxs("p", { className: "flex items-start gap-2 m-0", children: [
          /* @__PURE__ */ jsx("span", { className: "codicon codicon-folder shrink-0" }),
          /* @__PURE__ */ jsx("span", { className: "m-0 text-sm font-mono font-medium text-vscode-descriptionForeground", children: worktree.path })
        ] })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "flex items-start gap-2 px-5 py-2", children: [
        /* @__PURE__ */ jsx("span", { className: "codicon codicon-warning text-vscode-charts-yellow shrink-0" }),
        /* @__PURE__ */ jsxs("div", { className: "flex flex-col min-w-0 gap-2", children: [
          /* @__PURE__ */ jsx("p", { className: "m-0 text-vscode-foreground", children: t("delete.warning") }),
          /* @__PURE__ */ jsxs("ul", { className: "m-0 pl-0 list-none space-y-1 text-vscode-descriptionForeground", children: [
            /* @__PURE__ */ jsxs("li", { children: [
              "\u2022 ",
              t("delete.warningBranch")
            ] }),
            /* @__PURE__ */ jsxs("li", { children: [
              "\u2022 ",
              t("delete.warningFiles")
            ] })
          ] }),
          /* @__PURE__ */ jsx("p", { className: "m-0 text-vscode-descriptionForeground", children: t("delete.noticeLarge") })
        ] })
      ] }),
      worktree.isLocked && /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
        /* @__PURE__ */ jsx(
          Checkbox,
          {
            checked: forceDeleteLocked,
            onCheckedChange: (checked) => setForceDeleteLocked(checked === true)
          }
        ),
        /* @__PURE__ */ jsxs("label", { className: "text-sm text-vscode-foreground cursor-pointer", children: [
          t("delete.force"),
          /* @__PURE__ */ jsxs("span", { className: "text-vscode-descriptionForeground ml-1", children: [
            "(",
            t("delete.isLocked"),
            ")"
          ] })
        ] })
      ] }),
      error && /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2 px-2 py-1.5 rounded bg-vscode-inputValidation-errorBackground border border-vscode-inputValidation-errorBorder text-sm", children: [
        /* @__PURE__ */ jsx("span", { className: "codicon codicon-error text-vscode-errorForeground shrink-0" }),
        /* @__PURE__ */ jsx("p", { className: "text-vscode-errorForeground", children: error })
      ] })
    ] }),
    /* @__PURE__ */ jsxs(DialogFooter, { children: [
      /* @__PURE__ */ jsx(Button, { variant: "secondary", onClick: onClose, children: t("common.cancel") }),
      /* @__PURE__ */ jsx(Button, { variant: "destructive", onClick: () => void handleDelete(), disabled: isDeleting, children: isDeleting ? /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("span", { className: "codicon codicon-loading codicon-modifier-spin mr-2" }),
        t("delete.deleting")
      ] }) : t("delete.delete") })
    ] })
  ] }) });
}
function useWorktreeList(api) {
  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);
  const inFlight = useRef(false);
  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    void ask(api, "list").then((response) => {
      setListing(response);
      setError(response.error && response.isGitRepo ? response.error : null);
    }).catch((listError) => setError(listError instanceof Error ? listError.message : String(listError))).finally(() => {
      inFlight.current = false;
    });
  }, [api]);
  useEffect(() => refresh(), [refresh]);
  return { listing, error, refresh };
}

// ui/settings.tsx
import { Fragment as Fragment2, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function SectionHeader({ children }) {
  return /* @__PURE__ */ jsx2("div", { className: "sticky top-0 z-10 text-vscode-sideBar-foreground bg-vscode-sideBar-background px-5 pt-6 pb-4", children: /* @__PURE__ */ jsx2("h3", { className: "text-[1.25em] font-semibold text-vscode-foreground m-0", children }) });
}
function Unavailable({ title, reason, detail }) {
  return /* @__PURE__ */ jsxs2("div", { children: [
    /* @__PURE__ */ jsx2(SectionHeader, { children: title }),
    /* @__PURE__ */ jsxs2("div", { className: "px-5 text-sm", children: [
      /* @__PURE__ */ jsx2("p", { children: reason }),
      detail
    ] })
  ] });
}
function WorktreesSettings({ api }) {
  const t = usePluginTranslation2();
  const { listing, error, refresh } = useWorktreeList(api);
  const [includeStatus, setIncludeStatus] = useState2(null);
  const [isCreatingInclude, setIsCreatingInclude] = useState2(false);
  const [showCreate, setShowCreate] = useState2(false);
  const [pendingDelete, setPendingDelete] = useState2(null);
  const refreshInclude = useCallback2(() => {
    void ask(api, "include-status").then(setIncludeStatus).catch(() => setIncludeStatus(null));
  }, [api]);
  useEffect2(() => refreshInclude(), [refreshInclude]);
  const handleCreateInclude = useCallback2(async () => {
    if (!includeStatus?.gitignoreContent) return;
    setIsCreatingInclude(true);
    try {
      await ask(api, "create-include", { content: includeStatus.gitignoreContent }, true);
    } finally {
      setIsCreatingInclude(false);
      refreshInclude();
    }
  }, [api, includeStatus, refreshInclude]);
  const title = t("view.title");
  if (listing && !listing.isGitRepo && listing.gitRootPath === "" && listing.error === "no-workspace") {
    return /* @__PURE__ */ jsx2(Unavailable, { title, reason: t("view.noWorkspace") });
  }
  if (listing?.isMultiRoot) {
    return /* @__PURE__ */ jsx2(Unavailable, { title, reason: t("view.multiRootNotSupported") });
  }
  if (listing && !listing.isGitRepo) {
    return /* @__PURE__ */ jsx2(Unavailable, { title, reason: t("view.notGitRepo") });
  }
  if (listing?.isSubfolder) {
    return /* @__PURE__ */ jsx2(
      Unavailable,
      {
        title,
        reason: t("view.subfolderNotSupported"),
        detail: /* @__PURE__ */ jsxs2("p", { children: [
          t("view.gitRoot"),
          ":",
          " ",
          /* @__PURE__ */ jsx2("code", { className: "bg-vscode-input-background p-1 rounded-md", children: listing.gitRootPath })
        ] })
      }
    );
  }
  return /* @__PURE__ */ jsxs2("div", { className: "flex flex-col", children: [
    /* @__PURE__ */ jsx2(SectionHeader, { children: title }),
    /* @__PURE__ */ jsxs2("div", { className: "flex flex-col gap-2 px-5 py-2", children: [
      /* @__PURE__ */ jsx2("p", { className: "text-vscode-descriptionForeground text-sm m-0", children: t("view.description") }),
      /* @__PURE__ */ jsxs2(Button2, { variant: "secondary", className: "py-1", onClick: () => setShowCreate(true), children: [
        /* @__PURE__ */ jsx2("span", { className: "codicon codicon-add mr-1" }),
        t("view.newWorktree")
      ] })
    ] }),
    /* @__PURE__ */ jsx2("div", { className: "px-4 py-2", children: !listing ? /* @__PURE__ */ jsx2("div", { className: "flex items-center justify-center h-24", children: /* @__PURE__ */ jsx2("span", { className: "codicon codicon-loading codicon-modifier-spin text-2xl" }) }) : error ? /* @__PURE__ */ jsxs2("div", { className: "flex flex-col items-center justify-center h-24 text-vscode-errorForeground", children: [
      /* @__PURE__ */ jsx2("span", { className: "codicon codicon-error text-2xl mb-2" }),
      /* @__PURE__ */ jsx2("p", { className: "text-center", children: error })
    ] }) : /* @__PURE__ */ jsx2("div", { className: "flex flex-col gap-1", children: listing.worktrees.map((worktree) => /* @__PURE__ */ jsx2(
      "div",
      {
        className: cn(
          "p-2.5 px-3.5 rounded-xl border border-transparent",
          worktree.isCurrent ? "bg-vscode-list-activeSelectionBackground border-vscode-list-activeSelectionForeground/20" : "hover:bg-vscode-list-hoverBackground"
        ),
        children: /* @__PURE__ */ jsxs2("div", { className: "flex items-center justify-between gap-2 overflow-hidden", children: [
          /* @__PURE__ */ jsxs2("div", { className: "flex-1 min-w-0", children: [
            /* @__PURE__ */ jsxs2("div", { className: "flex items-center gap-2 overflow-hidden", children: [
              /* @__PURE__ */ jsx2("span", { className: "codicon codicon-git-branch shrink-0" }),
              /* @__PURE__ */ jsx2("span", { className: "font-medium truncate", children: worktreeLabel(worktree, t) }),
              worktree.isBare && /* @__PURE__ */ jsx2(Badge, { className: "text-[0.7em] py-0.5", children: t("view.primary") }),
              worktree.isLocked && /* @__PURE__ */ jsx2(StandardTooltip, { content: worktree.lockReason || t("view.locked"), children: /* @__PURE__ */ jsx2("span", { className: "codicon codicon-lock text-vscode-charts-yellow" }) })
            ] }),
            /* @__PURE__ */ jsxs2("div", { className: "flex gap-2 text-xs text-vscode-descriptionForeground mt-1", children: [
              /* @__PURE__ */ jsx2("span", { className: "codicon codicon-folder shrink-0" }),
              /* @__PURE__ */ jsx2("span", { className: "truncate", children: worktree.path })
            ] })
          ] }),
          /* @__PURE__ */ jsx2(StandardTooltip, { content: t("delete.delete"), children: /* @__PURE__ */ jsx2(
            Button2,
            {
              variant: "ghost",
              size: "icon",
              disabled: worktree.isCurrent || worktree.isBare,
              onClick: () => setPendingDelete(worktree),
              children: /* @__PURE__ */ jsx2("span", { className: "codicon codicon-trash text-vscode-errorForeground" })
            }
          ) })
        ] })
      },
      worktree.path
    )) }) }),
    includeStatus && /* @__PURE__ */ jsx2("div", { className: "flex items-center gap-2 text-sm px-5 py-3 justify-between text-vscode-descriptionForeground border-t border-vscode-sideBar-background", children: includeStatus.exists ? /* @__PURE__ */ jsx2("span", { children: t("view.includeFileExists") }) : /* @__PURE__ */ jsxs2(Fragment2, { children: [
      /* @__PURE__ */ jsx2("span", { children: t("view.noIncludeFile") }),
      includeStatus.hasGitignore && /* @__PURE__ */ jsx2(
        Button2,
        {
          variant: "secondary",
          size: "sm",
          onClick: () => void handleCreateInclude(),
          disabled: isCreatingInclude,
          children: t("view.createFromGitignore")
        }
      )
    ] }) }),
    /* @__PURE__ */ jsx2(
      CreateWorktreeDialog,
      {
        api,
        open: showCreate,
        onClose: () => setShowCreate(false),
        onCreated: () => {
          refresh();
          refreshInclude();
        }
      }
    ),
    pendingDelete && /* @__PURE__ */ jsx2(
      DeleteWorktreeDialog,
      {
        api,
        worktree: pendingDelete,
        open: true,
        onClose: () => setPendingDelete(null),
        onDeleted: refresh
      }
    )
  ] });
}
export {
  WorktreesSettings as default
};
