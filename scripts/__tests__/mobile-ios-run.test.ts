import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireBuildLock,
  createMobileIosCachePaths,
  ensureIosProject,
  ensureSharedBuildCache,
  nodeFileSystem,
  resolveSharedBuildPath,
  validateExpoRunIosArgs,
  type Clock,
  type MobileIosCachePaths,
  type Runner,
} from '../mobile-ios-run';

const clock: Clock = {
  now: () => new Date('2026-06-05T10:00:00.000Z').getTime(),
  isoNow: () => '2026-06-05T10:00:00.000Z',
};

const realClock: Clock = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

function makeTempDir(): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'boardsesh-mobile-ios-run-'));
  tempDirs.push(tempDir);
  return tempDir;
}

function makePaths(tempDir: string): MobileIosCachePaths {
  const mobileDir = join(tempDir, 'packages', 'mobile');
  const sharedBuildPath = join(tempDir, 'shared-cache', 'build');
  return {
    mobileDir,
    iosDir: join(mobileDir, 'ios'),
    localBuildPath: join(mobileDir, 'ios', 'build'),
    sharedBuildPath,
    lockPath: join(dirname(sharedBuildPath), '.xcode-build.lock'),
  };
}

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

describe('mobile-ios-run cache paths', () => {
  it('uses the explicit shared cache env override', () => {
    const sharedCachePath = resolve('/tmp/boardsesh-ios-cache');

    expect(resolveSharedBuildPath({ BOARDSESH_IOS_BUILD_CACHE_DIR: sharedCachePath })).toBe(sharedCachePath);
  });

  it('builds worktree-local and shared cache paths from the mobile dir', () => {
    const mobileDir = '/repo/packages/mobile';
    const paths = createMobileIosCachePaths({ BOARDSESH_IOS_BUILD_CACHE_DIR: '/cache/build' }, mobileDir);

    expect(paths.mobileDir).toBe(mobileDir);
    expect(paths.iosDir).toBe('/repo/packages/mobile/ios');
    expect(paths.localBuildPath).toBe('/repo/packages/mobile/ios/build');
    expect(paths.sharedBuildPath).toBe('/cache/build');
    expect(paths.lockPath).toBe('/cache/.xcode-build.lock');
  });

  it('rejects Expo cache-clearing flags', () => {
    expect(() => validateExpoRunIosArgs(['--device'])).not.toThrow();
    expect(() => validateExpoRunIosArgs(['--no-build-cache'])).toThrow(/clears iOS derived data/);
  });
});

describe('ensureIosProject', () => {
  it('skips prebuild when the generated iOS project exists', () => {
    const tempDir = makeTempDir();
    const paths = makePaths(tempDir);
    mkdirSync(paths.iosDir, { recursive: true });
    const run = vi.fn(() => 0);
    const runner: Runner = { run };

    ensureIosProject(paths, nodeFileSystem, runner);

    expect(run).not.toHaveBeenCalled();
  });

  it('runs Expo prebuild when packages/mobile/ios is missing', () => {
    const tempDir = makeTempDir();
    const paths = makePaths(tempDir);
    const run = vi.fn(() => 0);
    const runner: Runner = { run };

    ensureIosProject(paths, nodeFileSystem, runner);

    expect(run).toHaveBeenCalledWith('bunx', ['expo', 'prebuild', '--platform', 'ios'], {
      cwd: paths.mobileDir,
      env: expect.any(Object),
    });
  });
});

describe('ensureSharedBuildCache', () => {
  it('creates a worktree build symlink to the shared cache', () => {
    const tempDir = makeTempDir();
    const paths = makePaths(tempDir);
    mkdirSync(paths.iosDir, { recursive: true });

    const result = ensureSharedBuildCache(paths, nodeFileSystem, clock);

    expect(result).toEqual({
      sharedBuildPath: paths.sharedBuildPath,
      localBuildPath: paths.localBuildPath,
      movedAsidePath: null,
      importedExistingBuild: false,
    });
    expect(lstatSync(paths.localBuildPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(paths.localBuildPath)).toBe(paths.sharedBuildPath);
    expect(existsSync(paths.sharedBuildPath)).toBe(true);
  });

  it('imports an existing local build when the shared cache is missing', () => {
    const tempDir = makeTempDir();
    const paths = makePaths(tempDir);
    writeFile(join(paths.localBuildPath, 'Products', 'App.app'), 'local build');

    const result = ensureSharedBuildCache(paths, nodeFileSystem, clock);

    expect(result.importedExistingBuild).toBe(true);
    expect(readFileSync(join(paths.sharedBuildPath, 'Products', 'App.app'), 'utf8')).toBe('local build');
    expect(lstatSync(paths.localBuildPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(paths.localBuildPath)).toBe(paths.sharedBuildPath);
  });

  it('imports an existing local build when the shared cache is empty', () => {
    const tempDir = makeTempDir();
    const paths = makePaths(tempDir);
    mkdirSync(paths.sharedBuildPath, { recursive: true });
    writeFile(join(paths.localBuildPath, 'Products', 'App.app'), 'local build');

    const result = ensureSharedBuildCache(paths, nodeFileSystem, clock);

    expect(result.importedExistingBuild).toBe(true);
    expect(readFileSync(join(paths.sharedBuildPath, 'Products', 'App.app'), 'utf8')).toBe('local build');
    expect(lstatSync(paths.localBuildPath).isSymbolicLink()).toBe(true);
  });

  it('moves an existing local build aside when the shared cache has content', () => {
    const tempDir = makeTempDir();
    const paths = makePaths(tempDir);
    writeFile(join(paths.sharedBuildPath, 'Products', 'Cached.app'), 'shared build');
    writeFile(join(paths.localBuildPath, 'Products', 'App.app'), 'local build');

    const result = ensureSharedBuildCache(paths, nodeFileSystem, clock);

    expect(result.importedExistingBuild).toBe(false);
    expect(result.movedAsidePath).toBe(`${paths.localBuildPath}.worktree-2026-06-05T10-00-00-000Z`);
    expect(readFileSync(join(result.movedAsidePath!, 'Products', 'App.app'), 'utf8')).toBe('local build');
    expect(readFileSync(join(paths.sharedBuildPath, 'Products', 'Cached.app'), 'utf8')).toBe('shared build');
    expect(lstatSync(paths.localBuildPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(paths.localBuildPath)).toBe(paths.sharedBuildPath);
  });

  it('repairs a wrong build symlink without deleting its target', () => {
    const tempDir = makeTempDir();
    const paths = makePaths(tempDir);
    const wrongTarget = join(tempDir, 'wrong-cache');
    mkdirSync(paths.iosDir, { recursive: true });
    mkdirSync(wrongTarget, { recursive: true });
    writeFile(join(wrongTarget, 'keep.txt'), 'wrong cache data');
    symlinkBuildDir(wrongTarget, paths.localBuildPath);

    ensureSharedBuildCache(paths, nodeFileSystem, clock);

    expect(readlinkSync(paths.localBuildPath)).toBe(paths.sharedBuildPath);
    expect(readFileSync(join(wrongTarget, 'keep.txt'), 'utf8')).toBe('wrong cache data');
  });
});

describe('acquireBuildLock', () => {
  it('blocks concurrent users and releases the lock', () => {
    const tempDir = makeTempDir();
    const paths = makePaths(tempDir);

    const firstLock = acquireBuildLock(paths, nodeFileSystem, realClock);

    expect(existsSync(paths.lockPath)).toBe(true);
    expect(() => acquireBuildLock(paths, nodeFileSystem, realClock)).toThrow(/another Boardsesh iOS build/);

    firstLock.release();

    expect(existsSync(paths.lockPath)).toBe(false);
  });

  it('replaces stale lock directories', () => {
    const tempDir = makeTempDir();
    const paths = makePaths(tempDir);
    mkdirSync(paths.lockPath, { recursive: true });
    const staleTime = new Date(clock.now() - 13 * 60 * 60 * 1000);
    utimesSync(paths.lockPath, staleTime, staleTime);

    const lock = acquireBuildLock(paths, nodeFileSystem, clock);

    expect(lock.path).toBe(paths.lockPath);
    expect(readFileSync(join(paths.lockPath, 'owner.txt'), 'utf8')).toContain('sharedBuildPath=');
    lock.release();
  });
});

function symlinkBuildDir(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  nodeFileSystem.symlink(target, path);
}
