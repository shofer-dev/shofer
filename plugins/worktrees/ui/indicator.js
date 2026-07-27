// ui/indicator.tsx
import { useCallback as useCallback2, useEffect as useEffect2, useMemo, useState as useState2 } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  StandardTooltip,
  cn,
  usePluginTranslation as usePluginTranslation2,
  useShoferPortal
} from "@shofer/plugin-ui";

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

// ui/indicator.tsx
import { Fragment as Fragment2, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
function WorktreeIndicator({ api }) {
  const t = usePluginTranslation2();
  const portalContainer = useShoferPortal();
  const { listing, refresh } = useWorktreeList(api);
  const { steps, reset } = useCreationProgress(api);
  const [open, setOpen] = useState2(false);
  const [modalOpen, setModalOpen] = useState2(false);
  const [status, setStatus] = useState2(null);
  const [loading, setLoading] = useState2(false);
  const [pendingCwd, setPendingCwd] = useState2(void 0);
  const [actionError, setActionError] = useState2(null);
  const task = api.context.task;
  const hasActiveTask = (task?.messageCount ?? 0) > 0;
  const canRepoint = task?.cwdMutable !== false;
  const locked = hasActiveTask && !canRepoint;
  const worktrees = useMemo(() => listing?.worktrees ?? [], [listing]);
  const selectable = worktrees.filter((w) => !w.isBare);
  const workspaceCurrent = worktrees.find((w) => w.isCurrent);
  const selected = useMemo(() => {
    if (hasActiveTask && task?.cwd) return worktrees.find((w) => w.path === task.cwd) ?? workspaceCurrent;
    if (pendingCwd) return worktrees.find((w) => w.path === pendingCwd) ?? workspaceCurrent;
    return workspaceCurrent;
  }, [hasActiveTask, task?.cwd, pendingCwd, worktrees, workspaceCurrent]);
  useEffect2(() => {
    void ask(api, "selection").then((selection) => setPendingCwd(selection.optedOut ? null : selection.cwd)).catch(() => void 0);
  }, [api]);
  const available = listing !== null && listing.isGitRepo && !listing.isMultiRoot && !listing.isSubfolder && listing.gitRootPath !== "";
  const disabledTooltip = listing === null ? "" : listing.gitRootPath === "" && !listing.isGitRepo ? t("picker.disabledNoFolder") : listing.isMultiRoot ? t("picker.disabledMultiRoot") : !listing.isGitRepo ? t("picker.disabledNotGitRepo") : listing.isSubfolder ? t("picker.disabledSubfolder") : "";
  const handleOpenChange = useCallback2(
    (isOpen) => {
      if (isOpen && !available) return;
      setOpen(isOpen);
      if (!isOpen) return;
      refresh();
      setLoading(true);
      void ask(api, "status", { cwd: selected?.path }).then(setStatus).catch(() => setStatus(null)).finally(() => setLoading(false));
    },
    [api, available, refresh, selected?.path]
  );
  const choose = useCallback2(
    async (cwd) => {
      setActionError(null);
      try {
        if (hasActiveTask && canRepoint && cwd) {
          await ask(api, "set-task-cwd", { cwd, taskId: task?.taskId }, true);
          return;
        }
        await ask(api, "select", { cwd });
        setPendingCwd(cwd);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      }
    },
    [api, hasActiveTask, canRepoint, task?.taskId]
  );
  const handleSelect = useCallback2(
    (worktree) => {
      setOpen(false);
      if (locked) return;
      void choose(worktree.isCurrent ? null : worktree.path);
    },
    [locked, choose]
  );
  const handleCreated = useCallback2(
    async (createdPath, branch) => {
      reset();
      refresh();
      if (hasActiveTask) {
        await choose(createdPath);
        return;
      }
      setActionError(null);
      try {
        await ask(api, "open-task", { cwd: createdPath, name: `worktree: ${branch}` }, true);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      }
    },
    [api, reset, refresh, choose, hasActiveTask]
  );
  return /* @__PURE__ */ jsxs2(Fragment2, { children: [
    /* @__PURE__ */ jsxs2(Popover, { open, onOpenChange: handleOpenChange, children: [
      /* @__PURE__ */ jsx2(StandardTooltip, { content: available ? t("picker.tooltip") : disabledTooltip, children: /* @__PURE__ */ jsxs2(
        PopoverTrigger,
        {
          disabled: !available,
          "aria-disabled": !available,
          className: cn(
            "inline-flex items-center gap-1 relative whitespace-nowrap px-1.5 py-1 text-xs",
            "bg-transparent border border-[rgba(255,255,255,0.08)] rounded-md text-vscode-foreground",
            "transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset",
            "max-w-[160px]",
            available ? "opacity-90 hover:opacity-100 hover:bg-[rgba(255,255,255,0.03)] hover:border-[rgba(255,255,255,0.15)] cursor-pointer" : "opacity-40 cursor-not-allowed"
          ),
          children: [
            /* @__PURE__ */ jsx2("span", { className: "codicon codicon-git-branch shrink-0" }),
            /* @__PURE__ */ jsx2("span", { className: "truncate", children: selected ? worktreeLabel(selected, t) : t("view.noBranch") }),
            /* @__PURE__ */ jsx2("span", { className: "codicon codicon-chevron-down shrink-0 opacity-70" })
          ]
        }
      ) }),
      /* @__PURE__ */ jsx2(
        PopoverContent,
        {
          align: "start",
          sideOffset: 4,
          container: portalContainer,
          className: "p-0 overflow-hidden min-w-72 max-w-80",
          children: /* @__PURE__ */ jsxs2("div", { className: "flex flex-col w-full", children: [
            /* @__PURE__ */ jsx2("div", { className: "px-3 pt-3 pb-2", children: /* @__PURE__ */ jsxs2("h4", { className: "text-sm font-semibold m-0 flex items-center gap-2", children: [
              /* @__PURE__ */ jsx2("span", { className: "codicon codicon-git-branch" }),
              selected ? worktreeLabel(selected, t) : t("view.noBranch")
            ] }) }),
            steps.length > 0 && /* @__PURE__ */ jsx2("div", { className: "px-3 pb-2", children: steps.map((s) => {
              const failed = s.detail?.startsWith("failed");
              return /* @__PURE__ */ jsxs2(
                "div",
                {
                  className: "flex items-center gap-2 py-0.5 text-xs text-vscode-descriptionForeground",
                  children: [
                    /* @__PURE__ */ jsx2(
                      "span",
                      {
                        className: cn(
                          "codicon shrink-0",
                          s.completed && !failed ? "codicon-check text-vscode-charts-green" : failed ? "codicon-error text-vscode-errorForeground" : "codicon-loading codicon-modifier-spin"
                        )
                      }
                    ),
                    /* @__PURE__ */ jsx2("span", { className: "truncate", children: t(`step.${s.step}`) }),
                    s.completed && /* @__PURE__ */ jsx2(
                      "span",
                      {
                        className: cn(
                          "ml-auto shrink-0",
                          failed ? "text-vscode-errorForeground" : "text-vscode-charts-green"
                        ),
                        children: s.detail
                      }
                    )
                  ]
                },
                s.step
              );
            }) }),
            loading ? /* @__PURE__ */ jsx2("div", { className: "flex items-center justify-center py-6", children: /* @__PURE__ */ jsx2("span", { className: "codicon codicon-loading codicon-modifier-spin text-lg" }) }) : status ? /* @__PURE__ */ jsxs2("div", { className: "max-h-[260px] overflow-y-auto px-3 pb-3 text-sm", children: [
              status.lastCommit && /* @__PURE__ */ jsxs2("div", { className: "mb-2", children: [
                /* @__PURE__ */ jsxs2("span", { className: "text-vscode-descriptionForeground", children: [
                  t("status.lastCommit"),
                  ":"
                ] }),
                " ",
                /* @__PURE__ */ jsx2("span", { className: "font-mono text-xs", children: status.lastCommit.hash }),
                " ",
                /* @__PURE__ */ jsx2("span", { className: "text-vscode-descriptionForeground", children: status.lastCommit.subject }),
                /* @__PURE__ */ jsxs2("div", { className: "text-xs text-vscode-descriptionForeground mt-0.5", children: [
                  status.lastCommit.relativeTime,
                  " \u2014 ",
                  status.lastCommit.author
                ] })
              ] }),
              !status.isBaseBranch && /* @__PURE__ */ jsxs2("div", { className: "flex gap-3 mb-2", children: [
                status.commitsAhead > 0 && /* @__PURE__ */ jsxs2("span", { className: "text-vscode-charts-green", children: [
                  "\u25B2 ",
                  status.commitsAhead,
                  " ",
                  t("status.ahead")
                ] }),
                status.commitsBehind > 0 && /* @__PURE__ */ jsxs2("span", { className: "text-vscode-charts-yellow", children: [
                  "\u25BC ",
                  status.commitsBehind,
                  " ",
                  t("status.behind")
                ] }),
                status.commitsAhead === 0 && status.commitsBehind === 0 && /* @__PURE__ */ jsx2("span", { className: "text-vscode-descriptionForeground", children: t("status.upToDate") })
              ] }),
              !status.isBaseBranch && status.filesChanged > 0 && /* @__PURE__ */ jsxs2("div", { className: "mb-1 text-vscode-descriptionForeground", children: [
                status.filesChanged,
                " ",
                t("status.filesChanged"),
                " (",
                status.insertions,
                "+ /",
                " ",
                status.deletions,
                "-)"
              ] }),
              status.hasUncommittedChanges && /* @__PURE__ */ jsxs2("div", { className: "mb-1 text-vscode-charts-yellow", children: [
                "\u26A0 ",
                status.uncommittedCount,
                " ",
                t("status.uncommittedChanges")
              ] }),
              !status.isBaseBranch && status.mergeReadiness.hasConflicts !== null && /* @__PURE__ */ jsx2(
                "div",
                {
                  className: cn(
                    "mb-1 flex items-center gap-1",
                    status.mergeReadiness.hasConflicts ? "text-vscode-errorForeground" : "text-vscode-charts-green"
                  ),
                  children: status.mergeReadiness.hasConflicts ? `\u26A0 ${t("status.conflictsDetected", { count: status.mergeReadiness.conflictedFiles.length })}` : `\u2705 ${t("status.safeToMerge")}`
                }
              )
            ] }) : /* @__PURE__ */ jsx2("div", { className: "px-3 pb-3 text-sm text-vscode-descriptionForeground", children: t("status.noData") }),
            actionError && /* @__PURE__ */ jsx2("div", { className: "px-3 pb-2 text-sm text-vscode-errorForeground", children: actionError }),
            !locked && /* @__PURE__ */ jsxs2(Fragment2, { children: [
              /* @__PURE__ */ jsx2("div", { className: "border-t border-vscode-dropdown-border" }),
              /* @__PURE__ */ jsxs2(
                "button",
                {
                  type: "button",
                  onClick: () => {
                    setOpen(false);
                    setModalOpen(true);
                  },
                  className: cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-sm text-left",
                    "bg-transparent border-none cursor-pointer",
                    "text-vscode-foreground hover:bg-vscode-list-hoverBackground",
                    "focus:outline-none focus-visible:bg-vscode-list-hoverBackground"
                  ),
                  children: [
                    /* @__PURE__ */ jsx2("span", { className: "codicon codicon-add shrink-0" }),
                    /* @__PURE__ */ jsx2("span", { children: t("picker.createNew") })
                  ]
                }
              )
            ] }),
            !locked && selectable.length > 1 && /* @__PURE__ */ jsxs2(Fragment2, { children: [
              /* @__PURE__ */ jsx2("div", { className: "border-t border-vscode-dropdown-border" }),
              /* @__PURE__ */ jsx2("div", { className: "px-3 pt-2 pb-1 text-[11px] font-semibold text-vscode-descriptionForeground uppercase tracking-wide", children: t("picker.selectWorktree") }),
              /* @__PURE__ */ jsx2("div", { className: "max-h-48 overflow-y-auto pb-1", children: selectable.map((worktree) => /* @__PURE__ */ jsxs2(
                "button",
                {
                  type: "button",
                  onClick: () => handleSelect(worktree),
                  className: cn(
                    "w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left",
                    "bg-transparent border-none cursor-pointer",
                    "text-vscode-foreground hover:bg-vscode-list-hoverBackground",
                    "focus:outline-none focus-visible:bg-vscode-list-hoverBackground"
                  ),
                  children: [
                    /* @__PURE__ */ jsx2("span", { className: "codicon codicon-git-branch shrink-0 opacity-80" }),
                    /* @__PURE__ */ jsx2("span", { className: "truncate flex-1", children: worktree.branch || worktree.path }),
                    selected?.path === worktree.path && /* @__PURE__ */ jsx2("span", { className: "codicon codicon-check shrink-0 opacity-80" })
                  ]
                },
                worktree.path
              )) })
            ] })
          ] })
        }
      )
    ] }),
    /* @__PURE__ */ jsx2(
      CreateWorktreeDialog,
      {
        api,
        open: modalOpen,
        onClose: () => setModalOpen(false),
        onCreated: (createdPath, branch) => void handleCreated(createdPath, branch)
      }
    )
  ] });
}
export {
  WorktreeIndicator as default
};
