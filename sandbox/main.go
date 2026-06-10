// shofer-sandbox — write-only sandbox wrapper for worktree-scoped shell commands.
//
// Usage:
//
//	shofer-sandbox <worktree-dir> [--] <command...>
//
// The wrapper applies a Landlock write-only sandbox (Linux 5.13+) or falls back
// to bubblewrap, then execs the target command. Reads remain unrestricted.
//
// Design: see todos/worktree-shell-sandboxing.md
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "usage: %s <worktree-dir> [--] <command...>\n", os.Args[0])
		os.Exit(1)
	}

	worktreeDir := os.Args[1]
	cmdArgs := os.Args[2:]

	// Skip the optional "--" separator.
	if len(cmdArgs) > 0 && cmdArgs[0] == "--" {
		cmdArgs = cmdArgs[1:]
	}

	if len(cmdArgs) == 0 {
		fmt.Fprintln(os.Stderr, "shofer-sandbox: no command provided")
		os.Exit(1)
	}

	// Resolve the worktree directory to an absolute path for path-beneath checks.
	absWorktree, err := filepath.Abs(worktreeDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "shofer-sandbox: failed to resolve worktree path: %v\n", err)
		os.Exit(1)
	}

	if err := applyLandlock(absWorktree); err != nil {
		if errors.Is(err, errLandlockUnavailable) {
			if err := fallbackBwrap(absWorktree, cmdArgs); err != nil {
				fmt.Fprintf(os.Stderr, "shofer-sandbox: bwrap fallback failed: %v\n", err)
				os.Exit(1)
			}
			return
		}
		fmt.Fprintf(os.Stderr, "shofer-sandbox: landlock error: %v\n", err)
		os.Exit(1)
	}

	// Landlock applied successfully; exec the target command.
	execCmd(cmdArgs)
}

// errLandlockUnavailable is returned when the kernel does not support Landlock.
var errLandlockUnavailable = errors.New("landlock not available on this kernel")

// landlockSupportedABI is the highest ABI version the running kernel supports,
// or 0 if Landlock is unavailable. Determined once at startup via
// landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION).
var landlockSupportedABI int

// LANDLOCK_CREATE_RULESET_VERSION is the flag to query the supported ABI.
const landlockCreateRulesetVersion = 1

// All write-related Landlock FS access rights, in ABI-introduction order.
const (
	// ABI v1 (5.13) — the baseline.
	landlockWriteBase = unix.LANDLOCK_ACCESS_FS_WRITE_FILE |
		unix.LANDLOCK_ACCESS_FS_MAKE_REG |
		unix.LANDLOCK_ACCESS_FS_MAKE_DIR |
		unix.LANDLOCK_ACCESS_FS_MAKE_CHAR |
		unix.LANDLOCK_ACCESS_FS_MAKE_BLOCK |
		unix.LANDLOCK_ACCESS_FS_MAKE_FIFO |
		unix.LANDLOCK_ACCESS_FS_MAKE_SOCK |
		unix.LANDLOCK_ACCESS_FS_MAKE_SYM |
		unix.LANDLOCK_ACCESS_FS_REMOVE_FILE |
		unix.LANDLOCK_ACCESS_FS_REMOVE_DIR

	// ABI v2 (5.19)
	landlockWriteABI2 = landlockWriteBase | unix.LANDLOCK_ACCESS_FS_REFER

	// ABI v3 (6.2)
	landlockWriteABI3 = landlockWriteABI2 | unix.LANDLOCK_ACCESS_FS_TRUNCATE

	// ABI v5 (6.10) — full set including ioctl_dev control.
	landlockWriteABI5 = landlockWriteABI3 | unix.LANDLOCK_ACCESS_FS_IOCTL_DEV
)

// landlockWriteMaskForABI returns the write-related Landlock FS access mask
// supported by the given ABI version. Access rights unknown to the ABI are
// dropped so the kernel won't reject the ruleset with EINVAL.
func landlockWriteMaskForABI(abi int) uint64 {
	switch {
	case abi >= 5:
		return landlockWriteABI5
	case abi >= 3:
		return landlockWriteABI3
	case abi >= 2:
		return landlockWriteABI2
	default:
		return landlockWriteBase
	}
}

// queryLandlockABI probes the kernel for Landlock support and returns the
// highest supported ABI version, or 0 if unavailable.
func queryLandlockABI() int {
	// The canonical discovery pattern: landlock_create_ruleset(NULL, 0,
	// LANDLOCK_CREATE_RULESET_VERSION) returns the highest supported ABI.
	abi, _, errno := unix.Syscall(
		unix.SYS_LANDLOCK_CREATE_RULESET,
		0, // attr = NULL
		0, // size = 0
		uintptr(landlockCreateRulesetVersion),
	)
	if errno == unix.ENOSYS || errno == unix.EOPNOTSUPP {
		return 0
	}
	if errno != 0 {
		return 0
	}
	return int(abi)
}

// applyLandlock creates and enforces a Landlock ruleset that denies writes
// outside the given worktree directory.
//
// Allowed write paths:
//   - <worktree>/**    (the task's assigned worktree)
//   - /tmp/**           (shared temporary directory)
//   - /dev/null         (shell redirects to /dev/null)
//
// Reads from all paths remain unrestricted.
func applyLandlock(worktreeDir string) error {
	if landlockSupportedABI == 0 {
		return errLandlockUnavailable
	}

	// Disable privilege escalation so Landlock cannot be bypassed.
	// This must happen before the landlock_create_ruleset syscall.
	if _, _, errno := unix.Syscall(unix.SYS_PRCTL, unix.PR_SET_NO_NEW_PRIVS, 1, 0); errno != 0 {
		return fmt.Errorf("prctl(PR_SET_NO_NEW_PRIVS): %w", errno)
	}

	writeMask := landlockWriteMaskForABI(landlockSupportedABI)
	abi := unix.LandlockRulesetAttr{
		Access_fs: writeMask,
	}

	// flags must be 0 to create an enforcing ruleset.
	// LANDLOCK_CREATE_RULESET_VERSION (1) is only used for ABI queries
	// (attr=NULL, size=0).
	rulesetFd, _, errno := unix.Syscall(
		unix.SYS_LANDLOCK_CREATE_RULESET,
		uintptr(unsafe.Pointer(&abi)),
		uintptr(unsafe.Sizeof(abi)),
		0, // flags = 0 → enforcing ruleset
	)
	if errno != 0 {
		return fmt.Errorf("landlock_create_ruleset: %w", errno)
	}
	defer unix.Close(int(rulesetFd))

	// Allow writes to the worktree, /tmp, and /dev (for /dev/null redirects).
	allowedPaths := []string{
		worktreeDir,
		"/tmp",
		"/dev", // O_PATH on /dev/null (char device) may fail; use the parent dir
	}

	for _, p := range allowedPaths {
		if err := addWritePath(int(rulesetFd), p, writeMask); err != nil {
			return fmt.Errorf("adding %s to ruleset: %w", p, err)
		}
	}

	// Restrict self. After this call, no further rules can be added and the
	// process (and all its children) are sandboxed.
	if _, _, errno := unix.Syscall(unix.SYS_LANDLOCK_RESTRICT_SELF, rulesetFd, 0, 0); errno != 0 {
		return fmt.Errorf("landlock_restrict_self: %w", errno)
	}

	return nil
}

// addWritePath adds a Landlock rule allowing writes to the filesystem subtree
// rooted at the given path.
func addWritePath(rulesetFd int, path string, writeMask uint64) error {
	dirFd, err := unix.Open(path, unix.O_PATH|unix.O_CLOEXEC, 0)
	if err != nil {
		if os.IsNotExist(err) {
			// Non-existent paths are silently skipped — they can't be written to anyway.
			return nil
		}
		return err
	}
	defer unix.Close(dirFd)

	attr := unix.LandlockPathBeneathAttr{
		Allowed_access: writeMask,
		Parent_fd:      int32(dirFd),
	}

	_, _, errno := unix.Syscall6(
		unix.SYS_LANDLOCK_ADD_RULE,
		uintptr(rulesetFd),
		uintptr(unix.LANDLOCK_RULE_PATH_BENEATH),
		uintptr(unsafe.Pointer(&attr)),
		0,
		0,
		0,
	)
	if errno != 0 {
		return fmt.Errorf("landlock_add_rule: %w", errno)
	}

	return nil
}

// fallbackBwrap runs the command under bubblewrap with the worktree as the
// only writable location. Reads from the host filesystem still work because
// bind-mounts are read-only.
//
// Bind order: read-only / first, then overlay writable worktree + /tmp +
// /dev/null so they aren't shadowed by the ro-bind.
func fallbackBwrap(worktreeDir string, cmdArgs []string) error {
	bwrapPath, err := exec.LookPath("bwrap")
	if err != nil {
		return fmt.Errorf("bwrap not found (and landlock unavailable): %w", err)
	}

	bwrapArgs := []string{
		// Read-only root first — writable overlays follow.
		"--ro-bind", "/", "/",
		"--bind", worktreeDir, worktreeDir,
		"--bind", "/tmp", "/tmp",
		"--dev-bind", "/dev/null", "/dev/null",
		"--",
	}
	bwrapArgs = append(bwrapArgs, cmdArgs...)

	return syscall.Exec(bwrapPath, append([]string{"bwrap"}, bwrapArgs...), os.Environ())
}

// execCmd execs the target command, replacing the current process.
func execCmd(cmdArgs []string) {
	binary, err := exec.LookPath(cmdArgs[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "shofer-sandbox: command not found: %s\n", cmdArgs[0])
		os.Exit(127)
	}

	if err := syscall.Exec(binary, cmdArgs, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "shofer-sandbox: exec failed: %v\n", err)
		os.Exit(126)
	}
}

func init() {
	landlockSupportedABI = queryLandlockABI()
}
