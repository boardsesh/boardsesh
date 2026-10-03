package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const (
	forwarderUID = 65532
	forwarderGID = 65532
)

// prepareStateDirectory makes a root-owned mounted volume private and writable
// by the dedicated runtime identity before the process drops privileges.
func prepareStateDirectory(path string) error {
	if err := rejectSymlinkComponents(path); err != nil {
		return err
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return fmt.Errorf("create tsnet state directory: %w", err)
	}
	if err := rejectSymlinkComponents(path); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect tsnet state directory: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("tsnet state path must be a real directory")
	}
	if os.Geteuid() == 0 {
		if err := os.Chown(path, forwarderUID, forwarderUID); err != nil {
			return fmt.Errorf("assign tsnet state directory to the runtime identity: %w", err)
		}
	}
	if err := os.Chmod(path, 0o700); err != nil {
		return fmt.Errorf("restrict tsnet state directory permissions: %w", err)
	}
	return nil
}

func rejectSymlinkComponents(path string) error {
	cleanPath := filepath.Clean(path)
	if !filepath.IsAbs(cleanPath) {
		return fmt.Errorf("tsnet state path must be absolute")
	}
	currentPath := string(os.PathSeparator)
	for _, component := range strings.Split(strings.TrimPrefix(cleanPath, currentPath), currentPath) {
		if component == "" {
			continue
		}
		currentPath = filepath.Join(currentPath, component)
		info, err := os.Lstat(currentPath)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return fmt.Errorf("inspect tsnet state path component: %w", err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("tsnet state path must not contain symlinks")
		}
		if !info.IsDir() {
			return fmt.Errorf("tsnet state path component must be a directory")
		}
	}
	return nil
}

// dropPrivileges gives tsnet and all listeners only the state directory's
// dedicated UID/GID. Local non-root invocations retain their existing user.
func dropPrivileges() error {
	if os.Geteuid() != 0 {
		return nil
	}
	if err := syscall.Setgroups([]int{}); err != nil {
		return fmt.Errorf("clear supplementary groups: %w", err)
	}
	if err := syscall.Setresgid(forwarderGID, forwarderGID, forwarderGID); err != nil {
		return fmt.Errorf("drop to runtime GID %d: %w", forwarderGID, err)
	}
	if err := syscall.Setresuid(forwarderUID, forwarderUID, forwarderUID); err != nil {
		return fmt.Errorf("drop to runtime UID %d: %w", forwarderUID, err)
	}
	if os.Geteuid() != forwarderUID || os.Getegid() != forwarderGID {
		return fmt.Errorf("runtime identity drop did not take effect")
	}
	return nil
}
