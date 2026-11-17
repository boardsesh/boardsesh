import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  archiveStore,
  cacheName,
  eligibleArtifact,
  eligibleRun,
  main,
  MAX_BYTES,
  MAX_RUNS,
  selectStore,
  type PreviewRun,
} from './metro-preview-cache';

const directories: string[] = [];
function scratch() {
  const directory = mkdtempSync(join(tmpdir(), 'metro-preview-test-'));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function put(directory: string, path: string, contents = 'fixture') {
  const target = join(directory, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, contents);
}
function candidate() {
  const directory = scratch();
  execFileSync('git', ['init', '--quiet', directory]);
  for (const path of [
    'pnpm-lock.yaml',
    'package.json',
    'packages/mobile/package.json',
    'packages/mobile/metro.config.js',
    'packages/mobile/babel.config.js',
    'packages/mobile/app.config.ts',
    'patches/expo.patch',
    'packages/mobile/src/example.ts',
  ])
    put(directory, path);
  execFileSync('git', ['add', '.'], { cwd: directory });
  put(directory, 'packages/mobile/.env', 'EXPO_PUBLIC_URL=https://example.com');
  return directory;
}
const ENV = { PR_NUMBER: '123', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', EXPO_PUBLIC_URL: 'https://example.com' };
const run: PreviewRun = {
  id: 12,
  path: '.github/workflows/mobile-ota-preview.yml',
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
  repository: { id: 7 },
  head_repository: { id: 7 },
  pull_requests: [{ number: 123 }],
};
const artifact = {
  id: 34,
  name: 'metro-preview-pr-123-key',
  expired: false,
  size_in_bytes: 100,
  workflow_run: { id: 12 },
};

describe('preview cache keys', () => {
  it('reuses transforms across JS edits but invalidates config, lockfile, patch and env changes', () => {
    const directory = candidate();
    const initial = cacheName(directory, ENV);
    put(directory, 'packages/mobile/src/example.ts', 'changed JS');
    expect(cacheName(directory, ENV)).toBe(initial);
    for (const path of [
      'pnpm-lock.yaml',
      'package.json',
      'packages/mobile/package.json',
      'packages/mobile/metro.config.js',
      'packages/mobile/babel.config.js',
      'packages/mobile/app.config.ts',
      'patches/expo.patch',
    ]) {
      put(directory, path, 'changed');
      expect(cacheName(directory, ENV), path).not.toBe(initial);
      put(directory, path);
    }
    put(directory, 'packages/mobile/.env', 'EXPO_PUBLIC_URL=https://different.com');
    expect(cacheName(directory, ENV)).not.toBe(initial);
  });
  it('keys every public variable and runner identity, but never publisher credentials', () => {
    const directory = candidate();
    const initial = cacheName(directory, ENV);
    for (const override of [
      { EXPO_PUBLIC_URL: 'changed' },
      { EXPO_PUBLIC_NEW_FLAG: '1' },
      { RUNNER_OS: 'Windows' },
      { RUNNER_ARCH: 'ARM64' },
      { PR_NUMBER: '124' },
    ])
      expect(cacheName(directory, { ...ENV, ...override })).not.toBe(initial);
    expect(cacheName(directory, { ...ENV, EOO_TOKEN: 'secret', GH_TOKEN: 'secret' })).toBe(initial);
    expect(
      cacheName(directory, {
        EXPO_PUBLIC_URL: ENV.EXPO_PUBLIC_URL,
        RUNNER_ARCH: 'X64',
        RUNNER_OS: 'Linux',
        PR_NUMBER: '123',
      }),
    ).toBe(initial);
    expect(() => cacheName(directory, { ...ENV, PR_NUMBER: '../123' })).toThrow();
  });
});

describe('same-PR artifact selection', () => {
  it.each<Partial<PreviewRun>>([
    { id: 99 },
    { event: 'workflow_dispatch' },
    { event: 'pull_request_target' },
    { path: '.github/workflows/mobile-ota-production.yml' },
    { conclusion: 'failure' },
    { status: 'in_progress' },
    { head_repository: { id: 8 } },
    { repository: undefined },
    { pull_requests: [{ number: 124 }] },
    { pull_requests: [] },
  ])('rejects unrelated or unauthorized producer %j', (override) => {
    expect(eligibleRun({ ...run, ...override }, 123, 99)).toBe(false);
  });
  it('accepts only the exact, nonexpired, bounded artifact belonging to its run', () => {
    expect(eligibleArtifact(artifact, 12, artifact.name)).toBe(true);
    for (const override of [
      { name: 'metro-ota-store-key' },
      { expired: true },
      { size_in_bytes: 0 },
      { size_in_bytes: MAX_BYTES + 1 },
      { workflow_run: { id: 13 } },
    ])
      expect(eligibleArtifact({ ...artifact, ...override }, 12, artifact.name)).toBe(false);
  });
  it('does not query artifacts for rejected producers, and bounds run lookups', async () => {
    const listArtifacts = vi.fn(async () => [artifact]);
    expect(
      await selectStore([{ ...run, pull_requests: [{ number: 124 }] }, run], listArtifacts, 123, 99, artifact.name),
    ).toEqual({ run_id: 12, artifact_id: 34 });
    expect(listArtifacts.mock.calls).toEqual([[12]]);
    const empty = vi.fn(async () => []);
    await selectStore(
      Array.from({ length: MAX_RUNS + 10 }, (_, index) => ({ ...run, id: index + 100 })),
      empty,
      123,
      99,
      artifact.name,
    );
    expect(empty).toHaveBeenCalledTimes(MAX_RUNS);
  });
});

function maliciousArchive(path: string, name: string, kind = 'file', size = 1) {
  execFileSync('python3', [
    '-c',
    `import io, sys, tarfile
with tarfile.open(sys.argv[1], 'w') as archive:
    entry = tarfile.TarInfo(sys.argv[2])
    if sys.argv[3] == 'symlink':
        entry.type = tarfile.SYMTYPE
        entry.linkname = '/tmp'
    elif sys.argv[3] == 'hardlink':
        entry.type = tarfile.LNKTYPE
        entry.linkname = '/tmp/escaped'
    elif sys.argv[3] == 'fifo': entry.type = tarfile.FIFOTYPE
    else: entry.size = int(sys.argv[4])
    archive.addfile(entry, io.BytesIO(b'x' * entry.size))
    if sys.argv[3] == 'duplicate': archive.addfile(entry, io.BytesIO(b'x' * entry.size))
`,
    path,
    name,
    kind,
    String(size),
  ]);
}

describe('bounded archive handling', () => {
  it.each([
    ['../escaped', 'file'],
    ['/tmp/metro-preview-escaped', 'file'],
    ['metro-cache/aa/../../escaped', 'file'],
    ['metro-cache/aa/bb.mp', 'symlink'],
    ['metro-cache/aa/bb.mp', 'hardlink'],
    ['metro-cache/aa/bb.mp', 'fifo'],
    ['metro-cache/aa/bb.mp', 'duplicate'],
    ['metro-cache/unexpected', 'file'],
  ])('rejects %s (%s) and leaves an empty store', (name, kind) => {
    const directory = scratch();
    const archive = join(directory, 'cache.tar');
    maliciousArchive(archive, name, kind);
    const parent = join(directory, 'restore');
    expect(() => archiveStore('unpack', archive, parent)).toThrow();
    expect(readdirSync(join(parent, 'metro-cache'))).toEqual([]);
    expect(readdirSync(parent)).toEqual(['metro-cache']);
    expect(existsSync(join(directory, 'escaped'))).toBe(false);
  });
  it('rejects oversized archives and stores, and refuses links when packing', () => {
    const directory = scratch();
    const archive = join(directory, 'cache.tar');
    maliciousArchive(archive, 'metro-cache/aa/bb.mp', 'file', 2048);
    expect(() => archiveStore('unpack', archive, join(directory, 'restore'), 1024)).toThrow();
    put(directory, 'source/metro-cache/aa/bb.mp', 'x'.repeat(2048));
    expect(() => archiveStore('pack', archive, join(directory, 'source'), 1024)).toThrow();
    symlinkSync('/tmp', join(directory, 'source/metro-cache/cc'));
    expect(() => archiveStore('pack', archive, join(directory, 'source'))).toThrow();
  });
  it('supports a full miss → populate → pack → selected artifact → hit cycle', async () => {
    const directory = candidate();
    const outputs = join(directory, 'outputs');
    const env = { ...ENV, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: join(directory, 'summary') };
    await main(['key', directory], env);
    const name = readFileSync(outputs, 'utf8').trim().split('=')[1]!;
    expect(name).toMatch(/^metro-preview-pr-123-[0-9a-f]{64}$/);
    const parent = join(directory, 'metro');
    const archive = join(directory, 'cache.tar');
    await main(['unpack', archive, parent], env);
    expect(readFileSync(outputs, 'utf8')).toContain('store_ready=true');
    put(parent, 'metro-cache/aa/bbcc.mp', 'compiled transform');
    await main(['pack', parent, archive], env);
    expect(readFileSync(outputs, 'utf8')).toContain('archive_ready=true');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url.includes('/artifacts?') ? { artifacts: [{ ...artifact, name }] } : { workflow_runs: [run] },
      })),
    );
    await main(['select'], {
      ...env,
      GITHUB_REPOSITORY: 'boardsesh/boardsesh',
      GH_TOKEN: 'token',
      GITHUB_HEAD_REF: 'feature',
      GITHUB_RUN_ID: '99',
      METRO_STORE_ARTIFACT: name,
    });
    expect(readFileSync(outputs, 'utf8')).toContain('run_id=12\nartifact_id=34');
    const restored = join(directory, 'restored');
    await main(['unpack', archive, restored], env);
    expect(readFileSync(join(restored, 'metro-cache/aa/bbcc.mp'), 'utf8')).toBe('compiled transform');
    expect(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain('restored 1 entries');
  });
  it('reports failed lookup or invalid archive without a ready output or failed command', async () => {
    const directory = scratch();
    const env = { ...ENV, GITHUB_OUTPUT: join(directory, 'outputs') };
    const archive = join(directory, 'bad.tar');
    writeFileSync(archive, 'broken');
    await expect(main(['unpack', archive, join(directory, 'restore')], env)).resolves.toBeUndefined();
    await expect(main(['key', directory], env)).resolves.toBeUndefined();
    await expect(main(['select'], env)).resolves.toBeUndefined();
    expect(existsSync(env.GITHUB_OUTPUT)).toBe(false);
  });
});
