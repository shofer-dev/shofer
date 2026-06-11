package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestLandlockABIQuery verifies the ABI query returns a valid version number
// (including 0 on kernels without Landlock). This is purely a smoke test —
// whether Landlock is actually available depends on the host kernel.
func TestLandlockABIQuery(t *testing.T) {
	abi := queryLandlockABI()
	t.Logf("Landlock ABI support: %d (0 = unavailable)", abi)

	if abi < 0 || abi > 10 {
		t.Errorf("unexpected ABI version: %d", abi)
	}
}

// TestLandlockWriteMaskForABI verifies the right-set negotiation table.
func TestLandlockWriteMaskForABI(t *testing.T) {
	tests := []struct {
		abi       int
		wantNonZero bool
	}{
		{0, true},  // baseline (v1 rights)
		{1, true},  // v1
		{2, true},  // v2 adds REFER
		{3, true},  // v3 adds TRUNCATE
		{4, true},  // v4 same as v3
		{5, true},  // v5 adds IOCTL_DEV
		{100, true}, // future-proof: uses the full set
	}

	for _, tt := range tests {
		mask := landlockWriteMaskForABI(tt.abi)
		if tt.wantNonZero && mask == 0 {
			t.Errorf("ABI %d: expected non-zero mask, got 0", tt.abi)
		}
		// The write-file right (v1) should always be present.
		if mask&landlockWriteBase == 0 {
			t.Errorf("ABI %d: LANDLOCK_ACCESS_FS_WRITE_FILE missing from mask", tt.abi)
		}
	}
}

// TestLandlockWriteMaskMonotonic verifies that higher ABI versions never lose
// rights that earlier versions had.
func TestLandlockWriteMaskMonotonic(t *testing.T) {
	var prev uint64
	for abi := 0; abi <= 5; abi++ {
		cur := landlockWriteMaskForABI(abi)
		// cur must be a superset of prev.
		if cur&prev != prev {
			t.Errorf("ABI %d mask (0x%x) is not a superset of ABI %d mask (0x%x)", abi, cur, abi-1, prev)
		}
		prev = cur
	}
}

// TestBinaryIntegration runs the compiled shofer-sandbox binary and verifies:
//   - writes inside the worktree succeed
//   - writes outside the worktree are denied (EACCES)
//   - reads outside the worktree succeed (reads are unrestricted)
//
// This test requires either Landlock (kernel ≥ 5.13) or bwrap to be installed.
// On systems with neither, the test is skipped.
func TestBinaryIntegration(t *testing.T) {
	sandboxBin := "./shofer-sandbox"
	if _, err := os.Stat(sandboxBin); os.IsNotExist(err) {
		t.Skip("shofer-sandbox binary not built — run 'go build -o shofer-sandbox .' first")
	}

	// Create the worktree directory. Because /tmp is itself write-allowed
	// by the sandbox, the "outside" target must live somewhere NOT under
	// /tmp or /dev. Use the test's own working directory (which is the
	// sandbox source tree — not a write-allowed path).
	worktree, err := os.MkdirTemp("", "shofer-sandbox-test-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	defer os.RemoveAll(worktree)

	// Create the "outside" directory in the current working directory
	// (the sandbox source dir) — this is NOT in the Landlock ruleset.
	cwd, _ := os.Getwd()
	outsideDir := filepath.Join(cwd, "shofer-sandbox-outside-test")
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(outsideDir): %v", err)
	}
	defer os.RemoveAll(outsideDir)

	outsideFile := filepath.Join(outsideDir, "should-not-exist.txt")

	// 1. Write inside the worktree → must succeed.
	insidePath := filepath.Join(worktree, "test.txt")
	cmd := exec.Command(sandboxBin, worktree, "--",
		"/bin/sh", "-c", "echo hello > "+insidePath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("write inside worktree failed: %v\noutput: %s", err, out)
	}
	data, err := os.ReadFile(insidePath)
	if err != nil {
		t.Fatalf("ReadFile(%s): %v", insidePath, err)
	}
	if strings.TrimSpace(string(data)) != "hello" {
		t.Errorf("expected 'hello', got '%s'", strings.TrimSpace(string(data)))
	}

	// 2. Write outside the worktree → must fail with EACCES (or at least non-zero).
	cmd = exec.Command(sandboxBin, worktree, "--",
		"/bin/sh", "-c", "echo overwrite > "+outsideFile)
	out, err = cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("write outside worktree should have been denied, but succeeded\noutput: %s", out)
	}
	// Verify the file was NOT overwritten.
	data, _ = os.ReadFile(outsideFile)
	if strings.TrimSpace(string(data)) == "overwrite" {
		t.Errorf("outside file was overwritten despite sandbox")
	}

	// 3. Read outside the worktree → must succeed (reads unrestricted).
	cmd = exec.Command(sandboxBin, worktree, "--",
		"cat", "/etc/hostname")
	out, err = cmd.CombinedOutput()
	// cat may fail if /etc/hostname doesn't exist, but that's not a sandbox issue.
	if _, statErr := os.Stat("/etc/hostname"); statErr == nil {
		if err != nil && !strings.Contains(string(out), "No such file") {
			t.Fatalf("read outside worktree failed with unexpected error: %v\noutput: %s", err, out)
		}
	}
}

// TestParseWorktreeGitDir verifies parsing the worktree .git file.
func TestParseWorktreeGitDir(t *testing.T) {
	// Create a temp directory with a .git file simulating a git worktree.
	dir := t.TempDir()
	gitFile := filepath.Join(dir, ".git")
	gitDir := filepath.Join(dir, "..", "main", ".git", "worktrees", "test-wt")
	if err := os.MkdirAll(gitDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(gitDir): %v", err)
	}
	content := fmt.Sprintf("gitdir: %s\n", gitDir)
	if err := os.WriteFile(gitFile, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(.git): %v", err)
	}

	got, err := parseWorktreeGitDir(dir)
	if err != nil {
		t.Fatalf("parseWorktreeGitDir: %v", err)
	}
	if got != filepath.Clean(gitDir) {
		t.Errorf("expected %s, got %s", filepath.Clean(gitDir), got)
	}
}

// TestParseWorktreeGitDir_Relative verifies parsing a .git file with a
// relative gitdir path (rather than absolute).
func TestParseWorktreeGitDir_Relative(t *testing.T) {
	dir := t.TempDir()
	gitFile := filepath.Join(dir, ".git")
	content := "gitdir: ../.git/worktrees/some-task\n"
	if err := os.WriteFile(gitFile, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(.git): %v", err)
	}

	got, err := parseWorktreeGitDir(dir)
	if err != nil {
		t.Fatalf("parseWorktreeGitDir: %v", err)
	}
	expected := filepath.Join(dir, "..", ".git", "worktrees", "some-task")
	if got != filepath.Clean(expected) {
		t.Errorf("expected %s, got %s", filepath.Clean(expected), got)
	}
}

// TestParseWorktreeGitDir_NotAWorktree verifies that a directory without a
// .git file returns an error.
func TestParseWorktreeGitDir_NotAWorktree(t *testing.T) {
	dir := t.TempDir()
	_, err := parseWorktreeGitDir(dir)
	if err == nil {
		t.Error("expected error for non-worktree directory, got nil")
	}
}

// TestResolveWorktreeGitPaths_Integration verifies end-to-end resolution
// of git metadata paths from a simulated worktree directory.
func TestResolveWorktreeGitPaths_Integration(t *testing.T) {
	// Layout:
	//   repo/               ← repo root (contains .git/ dir)
	//     .git/             ← main .git directory
	//       objects/        ← shared objects dir
	//       refs/           ← shared refs dir
	//       worktrees/
	//         test-wt/
	//           commondir   ← contains "../.."
	//     sub/worktree/     ← the simulated checkout root
	//       .git            ← "gitdir: .../repo/.git/worktrees/test-wt"
	repo := t.TempDir()

	mainGit := filepath.Join(repo, ".git")
	wtGitDir := filepath.Join(mainGit, "worktrees", "test-wt")
	worktree := filepath.Join(repo, "sub", "worktree")

	// Create main .git directory (so resolveRepoRoot finds it).
	// Create shared .git objects/ and refs/
	for _, d := range []string{
		mainGit,
		filepath.Join(mainGit, "objects"),
		filepath.Join(mainGit, "refs"),
		wtGitDir,
	} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("MkdirAll(%s): %v", d, err)
		}
	}

	// Write commondir pointing back to the main .git
	if err := os.WriteFile(
		filepath.Join(wtGitDir, "commondir"),
		[]byte("../..\n"),
		0o644,
	); err != nil {
		t.Fatalf("WriteFile(commondir): %v", err)
	}

	// Write the worktree's .git file
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatalf("MkdirAll(worktree): %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(worktree, ".git"),
		[]byte(fmt.Sprintf("gitdir: %s\n", wtGitDir)),
		0o644,
	); err != nil {
		t.Fatalf("WriteFile(.git): %v", err)
	}

	paths := resolveWorktreeGitPaths(worktree)

	// Expected: the worktree git dir + main .git/objects + main .git/refs
	expectedObjs := filepath.Join(mainGit, "objects")
	expectedRefs := filepath.Join(mainGit, "refs")

	foundGitDir := false
	foundObjs := false
	foundRefs := false
	for _, p := range paths {
		switch p {
		case wtGitDir:
			foundGitDir = true
		case expectedObjs:
			foundObjs = true
		case expectedRefs:
			foundRefs = true
		}
	}

	if !foundGitDir {
		t.Errorf("expected git dir %s in paths, got %v", wtGitDir, paths)
	}
	if !foundObjs {
		t.Errorf("expected objects dir %s in paths, got %v", expectedObjs, paths)
	}
	if !foundRefs {
		t.Errorf("expected refs dir %s in paths, got %v", expectedRefs, paths)
	}
}

// TestResolveWorktreeGitPaths_TamperedGitFile verifies that a tampered .git
// file (e.g. gitdir: /etc) is rejected — no extra paths are whitelisted.
func TestResolveWorktreeGitPaths_TamperedGitFile(t *testing.T) {
	// Layout: same as integration test but the .git file points to /etc.
	repo := t.TempDir()
	mainGit := filepath.Join(repo, ".git")
	worktree := filepath.Join(repo, "sub", "worktree")

	for _, d := range []string{mainGit, worktree} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("MkdirAll(%s): %v", d, err)
		}
	}

	// Tampered .git file — points to /etc instead of the real gitdir.
	if err := os.WriteFile(
		filepath.Join(worktree, ".git"),
		[]byte("gitdir: /etc\n"),
		0o644,
	); err != nil {
		t.Fatalf("WriteFile(.git): %v", err)
	}

	paths := resolveWorktreeGitPaths(worktree)
	if paths != nil {
		t.Errorf("expected nil for tampered .git file, got %v", paths)
	}
}

// TestResolveWorktreeGitPaths_GitdirNotUnderRepo verifies that a gitdir
// pointing to a worktrees dir of a different repo is rejected.
func TestResolveWorktreeGitPaths_GitdirNotUnderRepo(t *testing.T) {
	repo := t.TempDir()
	mainGit := filepath.Join(repo, ".git")
	worktree := filepath.Join(repo, "sub", "worktree")

	// Create a fake .git/worktrees dir in a separate location.
	otherRepo := t.TempDir()
	otherGit := filepath.Join(otherRepo, ".git")
	otherWtDir := filepath.Join(otherGit, "worktrees", "evil-wt")

	for _, d := range []string{mainGit, worktree, otherGit, otherWtDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("MkdirAll(%s): %v", d, err)
		}
	}

	// .git file points to a different repo's worktree dir.
	if err := os.WriteFile(
		filepath.Join(worktree, ".git"),
		[]byte(fmt.Sprintf("gitdir: %s\n", otherWtDir)),
		0o644,
	); err != nil {
		t.Fatalf("WriteFile(.git): %v", err)
	}

	paths := resolveWorktreeGitPaths(worktree)
	if paths != nil {
		t.Errorf("expected nil for cross-repo gitdir, got %v", paths)
	}
}

// TestIsValidGitDir verifies the validation logic directly.
func TestIsValidGitDir(t *testing.T) {
	repo := "/repo"

	tests := []struct {
		name    string
		gitDir  string
		wantOk  bool
	}{
		{"legitimate path", "/repo/.git/worktrees/my-task", true},
		{"nested name", "/repo/.git/worktrees/sub/name", true},
		{"not under worktrees", "/repo/.git/objects", false},
		{"outside repo", "/etc/.git/worktrees/x", false},
		{"exactly worktrees dir", "/repo/.git/worktrees", false},
		{"path traversal in name", "/repo/.git/worktrees/../evil", false},
		{"dot component", "/repo/.git/worktrees/./evil", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isValidGitDir(repo, tt.gitDir)
			if got != tt.wantOk {
				t.Errorf("isValidGitDir(%q) = %v, want %v", tt.gitDir, got, tt.wantOk)
			}
		})
	}
}

// TestResolveRepoRoot verifies walking up to find the main .git directory.
func TestResolveRepoRoot(t *testing.T) {
	repo := t.TempDir()
	mainGit := filepath.Join(repo, ".git")
	if err := os.MkdirAll(mainGit, 0o755); err != nil {
		t.Fatalf("MkdirAll(.git): %v", err)
	}

	// Worktree deep in the repo.
	worktree := filepath.Join(repo, "a", "b", "c", "worktree")
	if err := os.MkdirAll(worktree, 0o755); err != nil {
		t.Fatalf("MkdirAll(worktree): %v", err)
	}

	got := resolveRepoRoot(worktree)
	if got != repo {
		t.Errorf("resolveRepoRoot(%s) = %s, want %s", worktree, got, repo)
	}
}

// TestResolveRepoRoot_NotFound verifies walking up with no .git dir anywhere.
func TestResolveRepoRoot_NotFound(t *testing.T) {
	dir := t.TempDir()
	got := resolveRepoRoot(dir)
	if got != "" {
		t.Errorf("expected empty string, got %s", got)
	}
}

// TestResolveWorktreeGitPaths_NonWorktree verifies that a directory without
// a .git file returns no extra paths.
func TestResolveWorktreeGitPaths_NonWorktree(t *testing.T) {
	dir := t.TempDir()
	paths := resolveWorktreeGitPaths(dir)
	if paths != nil {
		t.Errorf("expected nil for non-worktree dir, got %v", paths)
	}
}

// TestBinaryWriteTmp verifies that /tmp is writable under the sandbox.
func TestBinaryWriteTmp(t *testing.T) {
	sandboxBin := "./shofer-sandbox"
	if _, err := os.Stat(sandboxBin); os.IsNotExist(err) {
		t.Skip("shofer-sandbox binary not built — run 'go build -o shofer-sandbox .' first")
	}

	worktree, err := os.MkdirTemp("", "shofer-sandbox-test-")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	defer os.RemoveAll(worktree)

	cmd := exec.Command(sandboxBin, worktree, "--",
		"/bin/sh", "-c", "echo tmp-write-test > /tmp/shofer-sandbox-test.txt && cat /tmp/shofer-sandbox-test.txt")
	out, err := cmd.CombinedOutput()
	// Clean up regardless.
	os.Remove("/tmp/shofer-sandbox-test.txt")

	if err != nil {
		t.Fatalf("write to /tmp failed: %v\noutput: %s", err, out)
	}
	if !strings.Contains(string(out), "tmp-write-test") {
		t.Errorf("expected 'tmp-write-test' in output, got: %s", string(out))
	}
}
