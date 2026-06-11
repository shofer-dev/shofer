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
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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

	// Discover git metadata directories for git-worktree support.
	// In a git worktree, the ".git" is a plain file pointing to the real
	// git metadata directory (e.g. <main>/.git/worktrees/<name>).  Without
	// write access to that directory, git add/commit/checkout fails.
	extraPaths := resolveWorktreeGitPaths(absWorktree)

	if err := applyLandlock(absWorktree, extraPaths); err != nil {
		if errors.Is(err, errLandlockUnavailable) {
			if err := fallbackBwrap(absWorktree, extraPaths, cmdArgs); err != nil {
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
//   - extraPaths        (git metadata directories resolved via resolveWorktreeGitPaths)
//
// Reads from all paths remain unrestricted.
func applyLandlock(worktreeDir string, extraPaths []string) error {
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

	// Scope: worktree + /tmp + /dev/null (the device node, not /dev).
	// /dev/null is a character device — addWritePath detects non-directory
	// fds and masks down to file-applicable rights (WRITE_FILE, TRUNCATE,
	// IOCTL_DEV).  This keeps the write surface identical to bwrap
	// (--dev-bind /dev/null /dev/null).
	allowedPaths := []string{
		worktreeDir,
		"/tmp",
		"/dev/null",
	}
	allowedPaths = append(allowedPaths, extraPaths...)

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

// landlockWriteFileMask is the set of Landlock access rights applicable to
// non-directory file descriptors (regular files, device nodes).  Directory-
// only rights (MAKE_*, REMOVE_*, REFER) are excluded — the kernel rejects
// them with EINVAL when parent_fd is not a directory.
const landlockWriteFileMask = unix.LANDLOCK_ACCESS_FS_WRITE_FILE |
	unix.LANDLOCK_ACCESS_FS_TRUNCATE |
	unix.LANDLOCK_ACCESS_FS_IOCTL_DEV

// addWritePath adds a Landlock rule allowing writes at the given path.
// If the path is a directory the full writeMask is applied; for files and
// device nodes the mask is narrowed to file-applicable rights only.
func addWritePath(rulesetFd int, path string, writeMask uint64) error {
	fd, err := unix.Open(path, unix.O_PATH|unix.O_CLOEXEC, 0)
	if err != nil {
		if os.IsNotExist(err) {
			// Non-existent paths are silently skipped.
			return nil
		}
		return err
	}
	defer unix.Close(fd)

	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return fmt.Errorf("fstat %s: %w", path, err)
	}

	mask := writeMask
	if stat.Mode&unix.S_IFDIR == 0 {
		// Not a directory — only file-applicable rights are valid.
		mask &= landlockWriteFileMask
	}

	attr := unix.LandlockPathBeneathAttr{
		Allowed_access: mask,
		Parent_fd:      int32(fd),
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
		return fmt.Errorf("landlock_add_rule(%s): %w", path, errno)
	}

	return nil
}

// fallbackBwrap runs the command under bubblewrap with the worktree as the
// only writable location. Reads from the host filesystem still work because
// bind-mounts are read-only.
//
// Bind order: read-only / first, then overlay writable worktree + /tmp +
// /dev/null + extraPaths so they aren't shadowed by the ro-bind.
func fallbackBwrap(worktreeDir string, extraPaths []string, cmdArgs []string) error {
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
	}
	for _, p := range extraPaths {
		bwrapArgs = append(bwrapArgs, "--bind", p, p)
	}
	bwrapArgs = append(bwrapArgs, "--")
	bwrapArgs = append(bwrapArgs, cmdArgs...)

	return syscall.Exec(bwrapPath, append([]string{"bwrap"}, bwrapArgs...), os.Environ())
}

// resolveWorktreeGitPaths discovers git metadata directories that need write
// access inside a git worktree.
//
// In a git worktree, the ".git" in the checkout root is a plain file (not a
// directory) containing a "gitdir:" line that points to the real per-worktree
// metadata directory under .git/worktrees/<name>/.  Inside that directory,
// "commondir" points (usually via "../..") to the main .git directory where
// shared objects, refs, and logs live.
//
// Without write access to these directories, every git command that writes
// (add, commit, checkout, merge, …) fails inside a sandboxed worktree.
//
// Security: the .git file is writable by the sandboxed process (it lives inside
// the worktree).  Before whitelisting any gitdir, we validate that it lies under
// the same repository's .git/worktrees/ — a tampered .git file (e.g. gitdir: /etc)
// is rejected silently and no extra paths are whitelisted.
//
// Returns a list of absolute directory paths to whitelist.  On error or when
// the worktree root lacks a .git file, returns nil (git dir resolution is
// best-effort — non-git directories simply get no extra paths).
func resolveWorktreeGitPaths(worktreeDir string) []string {
	gitDir, err := parseWorktreeGitDir(worktreeDir)
	if err != nil || gitDir == "" {
		return nil
	}

	// Validate that the gitdir is under the same repository's
	// .git/worktrees/ — the .git file is writable from inside the
	// sandbox, so a malicious command could rewrite it to point to
	// /etc or another write-target.
	repoRoot := resolveRepoRoot(worktreeDir)
	if repoRoot == "" || !isValidGitDir(repoRoot, gitDir) {
		return nil
	}

	paths := []string{gitDir}

	// Resolve the commondir pointer (usually "../.." → main .git) to
	// also whitelist shared objects/ and refs/.  Use trailing-sep paths
	// so we only allow writes below those subdirectories, not to config
	// or hooks.
	if commonObj, commonRefs := parseCommondirPaths(gitDir); commonObj != "" {
		paths = append(paths, commonObj)
		if commonRefs != "" {
			paths = append(paths, commonRefs)
		}
	}

	return paths
}

// resolveRepoRoot finds the repository root by walking up from worktreeDir
// until it finds a directory containing .git (either as a directory or file).
// Returns the absolute path, or "" if not found.
func resolveRepoRoot(worktreeDir string) string {
	// Walk up from the worktreeDir to find the main repo root.  In a git
	// worktree, the checkout lives at any depth; the repo root is the
	// directory that contains the main .git directory.
	dir := filepath.Clean(worktreeDir)
	for {
		gitPath := filepath.Join(dir, ".git")
		if st, err := os.Stat(gitPath); err == nil {
			// .git exists and is a directory → this is the main repo root.
			if st.IsDir() {
				return dir
			}
			// .git exists and is a file → this is a worktree itself;
			// keep walking up toward the main repo.
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "" // reached root without finding main .git
		}
		dir = parent
	}
}

// isValidGitDir validates that gitDir is a legitimate git worktree metadata
// directory under the repository's .git/worktrees/.
//
// The pattern must be: <repoRoot>/.git/worktrees/<name>
// Where <name> is a non-empty path component (not ".", not "..").
func isValidGitDir(repoRoot, gitDir string) bool {
	worktreesPrefix := filepath.Join(repoRoot, ".git", "worktrees") + string(os.PathSeparator)

	// Must be under <repoRoot>/.git/worktrees/
	if !strings.HasPrefix(gitDir, worktreesPrefix) {
		return false
	}

	// Must not be exactly the worktrees directory itself.
	rel := strings.TrimPrefix(gitDir, worktreesPrefix)
	if rel == "" || rel == "." {
		return false
	}

	// Reject path traversal components.
	for _, part := range strings.Split(filepath.ToSlash(rel), "/") {
		if part == ".." || part == "." {
			return false
		}
	}

	return true
}

// parseWorktreeGitDir reads the "gitdir:" line from <worktreeDir>/.git and
// returns the absolute path to the per-worktree metadata directory.
func parseWorktreeGitDir(worktreeDir string) (string, error) {
	gitFile := filepath.Join(worktreeDir, ".git")
	data, err := os.ReadFile(gitFile)
	if err != nil {
		return "", err
	}

	line := strings.TrimSpace(string(data))
	if !strings.HasPrefix(line, "gitdir: ") {
		return "", fmt.Errorf("unexpected .git file content: %s", line)
	}

	gitDir := strings.TrimPrefix(line, "gitdir: ")
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(worktreeDir, gitDir)
	}

	return filepath.Clean(gitDir), nil
}

// parseCommondirPaths reads <gitDir>/commondir and returns the absolute paths
// to the shared objects/ and refs/ directories.  The commondir file contains a
// relative path from the per-worktree gitdir to the main .git directory
// (typically "../..").
//
// Returns objectsPath (ends in /objects) and refsPath (ends in /refs).
// If commondir cannot be read, both are empty strings.
func parseCommondirPaths(gitDir string) (objectsPath string, refsPath string) {
	commonFile := filepath.Join(gitDir, "commondir")
	rel, err := readFirstLine(commonFile)
	if err != nil || rel == "" {
		return "", ""
	}

	commonAbs := filepath.Join(gitDir, rel)
	commonAbs = filepath.Clean(commonAbs)

	objectsPath = filepath.Join(commonAbs, "objects")
	refsPath = filepath.Join(commonAbs, "refs")

	// Only return paths that actually exist — avoids polluting the ruleset
	// with phantom entries.
	if _, err := os.Stat(objectsPath); os.IsNotExist(err) {
		objectsPath = ""
	}
	if _, err := os.Stat(refsPath); os.IsNotExist(err) {
		refsPath = ""
	}

	return objectsPath, refsPath
}

// readFirstLine reads the first line of a file and returns it with whitespace
// trimmed.  Returns ("", nil) on ENOENT.
func readFirstLine(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	if scanner.Scan() {
		return strings.TrimSpace(scanner.Text()), nil
	}
	return "", scanner.Err()
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
