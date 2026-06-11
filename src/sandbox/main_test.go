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
	//   tmpdir/
	//     main/
	//       .git/
	//         objects/         ← shared objects dir
	//         refs/            ← shared refs dir
	//         worktrees/
	//           test-wt/
	//             commondir    ← contains "../.."
	//     worktree/            ← the simulated checkout root
	//       .git               ← "gitdir: .../worktrees/test-wt"
	tmpDir := t.TempDir()

	mainGit := filepath.Join(tmpDir, "main", ".git")
	wtGitDir := filepath.Join(mainGit, "worktrees", "test-wt")
	worktree := filepath.Join(tmpDir, "worktree")

	// Create shared .git objects/ and refs/
	for _, d := range []string{
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
