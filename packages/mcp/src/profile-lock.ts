import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { McpError } from './types';
import { secureWindowsDirectory } from './windows-security';

export interface ProfileLock {
  assertHeld(): void;
}

/** System parents may be aliases (macOS /var); the private leaf may not. */
export async function ensurePrivateDirectory(directory: string): Promise<void> {
  const absolute = resolve(directory);
  const existing = await lstat(absolute).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
    throw new McpError('unsafe_directory', 'The data directory must be a real directory, not a symlink.');
  }
  if (process.platform === 'win32') {
    // The Windows helper creates the leaf with its security descriptor already
    // attached; Node mkdir would first assign the token's possibly-group owner.
    await mkdir(dirname(absolute), { recursive: true });
  } else {
    await mkdir(absolute, { recursive: true, mode: 0o700 });
  }
  const canonical = join(await realpath(dirname(absolute)), basename(absolute));
  if (process.platform === 'win32') await secureWindowsDirectory(canonical);
  const attributes = await lstat(canonical);
  if (attributes.isSymbolicLink() || !attributes.isDirectory()) {
    throw new McpError('unsafe_directory', 'The data directory must be a real directory.');
  }
  if (process.getuid && attributes.uid !== process.getuid()) {
    throw new McpError('unsafe_directory', 'The data directory must belong to the current user.');
  }
  if (process.platform !== 'win32') await chmod(canonical, 0o700);
}

export function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Read-only liveness check; unlike acquiring the lock, it never waits. */
export async function isProfileLocked(directory: string): Promise<boolean> {
  return lockfile.check(resolve(directory), { realpath: false, stale: 120_000 }).catch(() => false);
}

/** A heartbeat keeps login/network work exclusive across all local clients. */
export async function withProfileLock<Result>(
  directory: string,
  operation: (guard: ProfileLock) => Promise<Result>,
): Promise<Result> {
  await ensurePrivateDirectory(directory);
  let compromised = false;
  let released = false;
  const guard: ProfileLock = {
    assertHeld() {
      if (compromised || released) {
        throw new McpError(
          'profile_lock_lost',
          'The local profile lock was lost. Retry after the other process finishes.',
        );
      }
    },
  };
  const release = await lockfile
    .lock(resolve(directory), {
      realpath: false,
      stale: 120_000,
      update: 10_000,
      retries: { retries: 12, minTimeout: 100, maxTimeout: 1000, factor: 1.3 },
      onCompromised: () => {
        compromised = true;
      },
    })
    .catch(() => {
      throw new McpError('profile_busy', 'Another local client is updating this profile. Retry shortly.');
    });
  try {
    guard.assertHeld();
    return await operation(guard);
  } finally {
    released = true;
    await release().catch(() => undefined);
  }
}
