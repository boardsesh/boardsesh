/// <reference types="node" />

import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { leaseEnvironment, resolveSimulatorUdid } from './lib/ios-simulator-lease';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  readFileSync,
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
  readFile(path: string): string;
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
  readFile: (path) => readFileSync(path, 'utf8'),
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
  const status = runner.run('vp', ['exec', 'expo', 'prebuild', '--platform', 'ios'], {
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
    throw new Error(
      `another Boardsesh iOS build is using the shared cache at ${paths.sharedBuildPath}. ` +
        `Wait for it to finish. A stopped owner's lock must be inspected and removed explicitly: ${paths.lockPath}`,
    );
  }

  const ownerToken = randomUUID();
  const ownerPath = join(paths.lockPath, 'owner.txt');
  const ownerContents = [
    `token=${ownerToken}`,
    `pid=${process.pid}`,
    `startedAt=${clock.isoNow()}`,
    `sharedBuildPath=${paths.sharedBuildPath}`,
    '',
  ].join('\n');
  fs.writeFile(ownerPath, ownerContents);

  return {
    path: paths.lockPath,
    release() {
      if (fs.exists(ownerPath) && fs.readFile(ownerPath) === ownerContents) fs.rm(paths.lockPath);
    },
  };
}

export function extractIosDeviceArgs(args: readonly string[]): { requested: string | undefined; remaining: string[] } {
  let requested: string | undefined;
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--device' || argument === '-d') {
      const candidate = args[++index];
      if (!candidate || candidate.startsWith('-')) throw new Error('Pass an explicit device name or UDID.');
      requested = candidate;
    } else if (argument.startsWith('--device=')) requested = argument.slice('--device='.length);
    else remaining.push(argument);
  }
  return { requested, remaining };
}

function isPhysicalDevice(requested: string): boolean {
  const listing = execFileSync('xcrun', ['xctrace', 'list', 'devices'], { encoding: 'utf8', timeout: 15000 });
  const physicalSection = listing.split('== Simulators ==')[0];
  return physicalSection
    .split('\n')
    .some((line) => line.includes(`(${requested})`) || line.startsWith(`${requested} (`));
}

export function main(): number {
  const passthroughArgs = process.argv.slice(2).filter((argument) => argument !== '--');

  try {
    validateExpoRunIosArgs(passthroughArgs);
    const { requested, remaining } = extractIosDeviceArgs(passthroughArgs);
    let simulator: ReturnType<typeof leaseEnvironment>;
    try {
      const udid = resolveSimulatorUdid(requested);
      simulator = leaseEnvironment(udid, ROOT_DIR);
      remaining.push('--device', udid);
    } catch (error) {
      if (!requested || !isPhysicalDevice(requested)) throw error;
      // Physical iPhone builds cannot interfere with a simulator lease.
      simulator = { env: { ...process.env }, release() {} };
      remaining.push('--device', requested);
    }

    try {
      const paths = createMobileIosCachePaths();
      const lock = acquireBuildLock(paths, nodeFileSystem, systemClock);
      try {
        ensureIosProject(paths, nodeFileSystem, nodeRunner);
        const cacheResult = ensureSharedBuildCache(paths, nodeFileSystem, systemClock);

        console.log(`[mobile:ios] Shared Xcode build cache: ${cacheResult.sharedBuildPath}`);
        if (cacheResult.importedExistingBuild) {
          console.log('[mobile:ios] Imported existing packages/mobile/ios/build into the shared cache.');
        }
        if (cacheResult.movedAsidePath) {
          console.log(`[mobile:ios] Preserved existing worktree build output at ${cacheResult.movedAsidePath}`);
        }

        const status = nodeRunner.run('vp', ['exec', 'expo', 'run:ios', ...remaining], {
          cwd: paths.mobileDir,
          env: simulator.env,
        });
        return status ?? 1;
      } finally {
        lock.release();
      }
    } finally {
      simulator.release();
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

function safeTimestamp(timestamp: string): string {
  return timestamp.replace(/[^0-9A-Za-z_-]/g, '-');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
