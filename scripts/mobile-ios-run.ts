/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOBILE_DIR = resolve(ROOT_DIR, 'packages', 'mobile');
const DEFAULT_CACHE_DIR = join(homedir(), 'Library', 'Caches', 'boardsesh', 'xcode', 'packages-mobile-ios', 'build');
const LOCK_STALE_MS = 12 * 60 * 60 * 1000;

export interface MobileIosCachePaths {
  mobileDir: string;
  iosDir: string;
  localBuildPath: string;
  sharedBuildPath: string;
  lockPath: string;
}

export interface FileSystemOps {
  exists(path: string): boolean;
  lstat(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean; mtimeMs?: number };
  mkdir(path: string): void;
  mkdirExclusive(path: string): void;
  readdir(path: string): string[];
  readlink(path: string): string;
  rename(from: string, to: string): void;
  rm(path: string): void;
  rmdir(path: string): void;
  symlink(target: string, path: string): void;
  writeFile(path: string, contents: string): void;
}

export interface Runner {
  run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): number | null;
}

export interface Clock {
  now(): number;
  isoNow(): string;
}

export interface EnsureCacheResult {
  sharedBuildPath: string;
  localBuildPath: string;
  movedAsidePath: string | null;
  importedExistingBuild: boolean;
}

export interface LockResult {
  path: string;
  release(): void;
}

export const nodeFileSystem: FileSystemOps = {
  exists: existsSync,
  lstat: lstatSync,
  mkdir(path) {
    mkdirSync(path, { recursive: true });
  },
  mkdirExclusive(path) {
    mkdirSync(path);
  },
  readdir: readdirSync,
  readlink: readlinkSync,
  rename: renameSync,
  rm(path) {
    rmSync(path, { force: true, recursive: true });
  },
  rmdir: rmdirSync,
  symlink: symlinkSync,
  writeFile: writeFileSync,
};

export const nodeRunner: Runner = {
  run(command, args, options) {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
    });
    return result.status;
  },
};

export const systemClock: Clock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};

export function resolveSharedBuildPath(env: NodeJS.ProcessEnv = process.env): string {
  const configuredPath = env.BOARDSESH_IOS_BUILD_CACHE_DIR?.trim();
  return resolve(configuredPath && configuredPath.length > 0 ? configuredPath : DEFAULT_CACHE_DIR);
}

export function createMobileIosCachePaths(
  env: NodeJS.ProcessEnv = process.env,
  mobileDir: string = MOBILE_DIR,
): MobileIosCachePaths {
  const sharedBuildPath = resolveSharedBuildPath(env);
  return {
    mobileDir,
    iosDir: join(mobileDir, 'ios'),
    localBuildPath: join(mobileDir, 'ios', 'build'),
    sharedBuildPath,
    lockPath: join(dirname(sharedBuildPath), '.xcode-build.lock'),
  };
}

export function validateExpoRunIosArgs(args: readonly string[]): void {
  if (args.some((argument) => argument === '--no-build-cache' || argument.startsWith('--no-build-cache='))) {
    throw new Error(
      '`--no-build-cache` clears iOS derived data. Remove it so the shared Boardsesh Xcode cache can stay warm.',
    );
  }
}

export function ensureIosProject(paths: MobileIosCachePaths, fs: FileSystemOps, runner: Runner): void {
  if (fs.exists(paths.iosDir)) return;

  console.log('[mobile:ios] packages/mobile/ios missing; running Expo prebuild for iOS...');
  const status = runner.run('bunx', ['expo', 'prebuild', '--platform', 'ios'], {
    cwd: paths.mobileDir,
    env: { ...process.env },
  });

  if (status !== 0) {
    throw new Error(`expo prebuild --platform ios failed with exit code ${status ?? 1}`);
  }
}

export function ensureSharedBuildCache(paths: MobileIosCachePaths, fs: FileSystemOps, clock: Clock): EnsureCacheResult {
  fs.mkdir(dirname(paths.sharedBuildPath));

  let importedExistingBuild = false;
  let movedAsidePath: string | null = null;

  if (fs.exists(paths.localBuildPath)) {
    const localBuildStats = fs.lstat(paths.localBuildPath);
    if (localBuildStats.isSymbolicLink()) {
      const currentTarget = resolve(dirname(paths.localBuildPath), fs.readlink(paths.localBuildPath));
      if (currentTarget === paths.sharedBuildPath) {
        fs.mkdir(paths.sharedBuildPath);
        return {
          sharedBuildPath: paths.sharedBuildPath,
          localBuildPath: paths.localBuildPath,
          movedAsidePath,
          importedExistingBuild,
        };
      }
      fs.rm(paths.localBuildPath);
    } else if (
      localBuildStats.isDirectory() &&
      (!fs.exists(paths.sharedBuildPath) || isEmptyDirectory(paths.sharedBuildPath, fs))
    ) {
      if (fs.exists(paths.sharedBuildPath)) {
        fs.rmdir(paths.sharedBuildPath);
      }
      fs.rename(paths.localBuildPath, paths.sharedBuildPath);
      importedExistingBuild = true;
    } else {
      movedAsidePath = `${paths.localBuildPath}.worktree-${safeTimestamp(clock.isoNow())}`;
      fs.rename(paths.localBuildPath, movedAsidePath);
    }
  }

  fs.mkdir(paths.sharedBuildPath);
  fs.symlink(paths.sharedBuildPath, paths.localBuildPath);

  return {
    sharedBuildPath: paths.sharedBuildPath,
    localBuildPath: paths.localBuildPath,
    movedAsidePath,
    importedExistingBuild,
  };
}

export function acquireBuildLock(paths: MobileIosCachePaths, fs: FileSystemOps, clock: Clock): LockResult {
  fs.mkdir(dirname(paths.lockPath));

  try {
    fs.mkdirExclusive(paths.lockPath);
  } catch {
    if (isStaleLock(paths.lockPath, fs, clock)) {
      fs.rm(paths.lockPath);
      fs.mkdirExclusive(paths.lockPath);
    } else {
      throw new Error(
        `another Boardsesh iOS build is using the shared cache at ${paths.sharedBuildPath}. ` +
          `Wait for it to finish, then rerun this command.`,
      );
    }
  }

  fs.writeFile(
    join(paths.lockPath, 'owner.txt'),
    [`pid=${process.pid}`, `startedAt=${clock.isoNow()}`, `sharedBuildPath=${paths.sharedBuildPath}`, ''].join('\n'),
  );

  return {
    path: paths.lockPath,
    release() {
      fs.rm(paths.lockPath);
    },
  };
}

export function main(): number {
  const passthroughArgs = process.argv.slice(2).filter((argument) => argument !== '--');

  try {
    validateExpoRunIosArgs(passthroughArgs);
    const paths = createMobileIosCachePaths();
    ensureIosProject(paths, nodeFileSystem, nodeRunner);
    const cacheResult = ensureSharedBuildCache(paths, nodeFileSystem, systemClock);

    console.log(`[mobile:ios] Shared Xcode build cache: ${cacheResult.sharedBuildPath}`);
    if (cacheResult.importedExistingBuild) {
      console.log('[mobile:ios] Imported existing packages/mobile/ios/build into the shared cache.');
    }
    if (cacheResult.movedAsidePath) {
      console.log(`[mobile:ios] Preserved existing worktree build output at ${cacheResult.movedAsidePath}`);
    }

    const lock = acquireBuildLock(paths, nodeFileSystem, systemClock);
    try {
      const status = nodeRunner.run('bunx', ['expo', 'run:ios', ...passthroughArgs], {
        cwd: paths.mobileDir,
        env: { ...process.env },
      });
      return status ?? 1;
    } finally {
      lock.release();
    }
  } catch (error) {
    console.error(`[mobile:ios] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function isEmptyDirectory(path: string, fs: FileSystemOps): boolean {
  try {
    const stats = fs.lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    return fs.readdir(path).length === 0;
  } catch {
    return false;
  }
}

function isStaleLock(path: string, fs: FileSystemOps, clock: Clock): boolean {
  try {
    const stats = fs.lstat(path);
    if (!stats.isDirectory()) return false;
    return typeof stats.mtimeMs === 'number' && clock.now() - stats.mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function safeTimestamp(timestamp: string): string {
  return timestamp.replace(/[^0-9A-Za-z_-]/g, '-');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
