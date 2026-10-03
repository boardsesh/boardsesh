package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestRootOwnedStateDirectoryBecomesWritableByRuntimeIdentity(t *testing.T) {
	const childMode = "FORWARDER_STATE_DIR_CHILD"
	if os.Getenv(childMode) == "1" {
		if err := dropPrivileges(); err != nil {
			t.Fatal(err)
		}
		if os.Geteuid() != forwarderUID || os.Getegid() != forwarderUID {
			t.Fatalf("runtime identity = %d:%d, want %d:%d", os.Geteuid(), os.Getegid(), forwarderUID, forwarderUID)
		}
		probePath := filepath.Join(os.Getenv("FORWARDER_STATE_DIR_PATH"), "identity-write-probe")
		if err := os.WriteFile(probePath, []byte("private"), 0o600); err != nil {
			t.Fatalf("write mounted state as runtime identity: %v", err)
		}
		return
	}
	if os.Geteuid() != 0 {
		t.Skip("root-owned mounted-volume behavior is exercised in CI under sudo")
	}

	stateDirectory, err := os.MkdirTemp("", "boardsesh-root-owned-volume-")
	if err != nil {
		t.Fatalf("create simulated mounted volume: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(stateDirectory) })
	if err := os.Chmod(stateDirectory, 0o755); err != nil {
		t.Fatalf("set Railway-like volume mode: %v", err)
	}
	if err := prepareStateDirectory(stateDirectory); err != nil {
		t.Fatalf("prepare root-owned mounted volume: %v", err)
	}
	info, err := os.Stat(stateDirectory)
	if err != nil {
		t.Fatalf("stat prepared mounted volume: %v", err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatal("mounted volume did not expose Unix ownership")
	}
	if stat.Uid != forwarderUID || stat.Gid != forwarderUID || info.Mode().Perm() != 0o700 {
		t.Fatalf("prepared state directory is uid=%d gid=%d mode=%#o", stat.Uid, stat.Gid, info.Mode().Perm())
	}

	for startupAttempt := 1; startupAttempt <= 2; startupAttempt++ {
		if startupAttempt == 2 {
			// The second root bootstrap models a restart against the existing
			// mounted volume and must preserve the runtime-owned identity file.
			if err := prepareStateDirectory(stateDirectory); err != nil {
				t.Fatalf("prepare existing mounted volume on restart: %v", err)
			}
		}
		child := exec.Command(os.Args[0], "-test.run=^TestRootOwnedStateDirectoryBecomesWritableByRuntimeIdentity$")
		child.Env = append(os.Environ(), childMode+"=1", "FORWARDER_STATE_DIR_PATH="+stateDirectory)
		output, err := child.CombinedOutput()
		if err != nil {
			t.Fatalf("runtime-identity write probe %d failed: %v\n%s", startupAttempt, err, output)
		}
	}
	probeInfo, err := os.Stat(filepath.Join(stateDirectory, "identity-write-probe"))
	if err != nil {
		t.Fatalf("stat runtime-identity write probe: %v", err)
	}
	probeStat, ok := probeInfo.Sys().(*syscall.Stat_t)
	if !ok || probeStat.Uid != forwarderUID || probeStat.Gid != forwarderUID {
		t.Fatalf("write probe owner is not the runtime identity: %#v", probeInfo.Sys())
	}
}

func TestRootStartupCannotChownAnOperatorSelectedPath(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("root-only state-path guard is covered by the CI root identity test")
	}
	_, err := loadConfig(testEnv(map[string]string{"TS_STATE_DIR": "/tmp/operator-selected-state"}))
	if err == nil || !strings.Contains(err.Error(), "root startup may only prepare the fixed tsnet state path") {
		t.Fatalf("root accepted a non-contract state path: %v", err)
	}
}

func TestPrepareStateDirectoryRejectsSymlinkComponents(t *testing.T) {
	root := t.TempDir()
	realDirectory := filepath.Join(root, "real")
	if err := os.Mkdir(realDirectory, 0o700); err != nil {
		t.Fatalf("create real directory: %v", err)
	}
	linkPath := filepath.Join(root, "link")
	if err := os.Symlink(realDirectory, linkPath); err != nil {
		t.Fatalf("create symlink: %v", err)
	}
	if err := prepareStateDirectory(filepath.Join(linkPath, "tsnet")); err == nil || !strings.Contains(err.Error(), "must not contain symlinks") {
		t.Fatalf("state path accepted a symlink component: %v", err)
	}
	if _, err := os.Stat(filepath.Join(realDirectory, "tsnet")); !os.IsNotExist(err) {
		t.Fatalf("symlink target was modified: %v", err)
	}
}
