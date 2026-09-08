/// <reference types="node" />

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXPECTED_APP_STORE_DEVICE_SLUGS, EXPECTED_APP_STORE_LOCALES } from '../assert-screenshot-dimensions';
import {
  BASELINE_TAG,
  type BaselineManifest,
  type CommandResult,
  type CommandRunner,
  type ScreenshotShardTree,
  assertCompleteTree,
  assetNameFor,
  buildManifest,
  fetchBaseline,
  packBaseline,
  parseAssetName,
  parseBaselineArguments,
  publishBaseline,
  readShardTree,
  verifyShardAgainstManifest,
} from '../screenshot-baseline';

/**
 * The baseline is what the probe gate compares against and what the store-draft
 * lane attaches to a new App Store version, so the two dangerous failure modes
 * are silence: publishing a tree that is short a locale (the next probe then
 * compares against a hole), and a manifest that lists assets which were never
 * uploaded. Both are pinned below.
 *
 * `gh` and `zip` are reached through an injected runner, so nothing here touches
 * the network or the filesystem outside a temp dir.
 */

interface RecordedCommand {
  command: string;
  args: string[];
}

class FakeRunner implements CommandRunner {
  readonly calls: RecordedCommand[] = [];

  constructor(private readonly results: (invocation: RecordedCommand) => CommandResult = () => ok()) {}

  run(command: string, args: readonly string[]): CommandResult {
    const invocation = { command, args: [...args] };
    this.calls.push(invocation);
    return this.results(invocation);
  }
}

function ok(stdout = ''): CommandResult {
  return { status: 0, stdout, stderr: '' };
}

function fail(stderr = 'release not found'): CommandResult {
  return { status: 1, stdout: '', stderr };
}

function completeTree(): ScreenshotShardTree {
  const tree: ScreenshotShardTree = {};
  for (const locale of EXPECTED_APP_STORE_LOCALES) {
    tree[locale] = {};
    for (const deviceSlug of EXPECTED_APP_STORE_DEVICE_SLUGS) {
      tree[locale][deviceSlug] = ['01-discover.png', '02-board.png'];
    }
  }
  return tree;
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'screenshot-baseline-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Materialise a complete (or deliberately holed) capture tree on disk. */
function writeTree(root: string, skip?: { locale?: string; deviceSlug?: string }): string {
  for (const locale of EXPECTED_APP_STORE_LOCALES) {
    if (locale === skip?.locale) continue;
    for (const deviceSlug of EXPECTED_APP_STORE_DEVICE_SLUGS) {
      if (deviceSlug === skip?.deviceSlug) continue;
      const shardDir = join(root, locale, deviceSlug);
      mkdirSync(shardDir, { recursive: true });
      writeFileSync(join(shardDir, '01-discover.png'), `${locale}/${deviceSlug}/01`);
      writeFileSync(join(shardDir, '02-board.png'), `${locale}/${deviceSlug}/02`);
    }
  }
  return root;
}

describe('assetNameFor / parseAssetName', () => {
  it('names one shard asset per locale and device', () => {
    expect(assetNameFor('ios', 'en-US', 'iphone-16-pro-max')).toBe('ios-en-US-iphone-16-pro-max.zip');
    expect(assetNameFor('ios', 'es-MX', 'ipad-pro-13-inch-m5')).toBe('ios-es-MX-ipad-pro-13-inch-m5.zip');
  });

  it('round-trips every shard name, dashes and all', () => {
    for (const locale of EXPECTED_APP_STORE_LOCALES) {
      for (const deviceSlug of EXPECTED_APP_STORE_DEVICE_SLUGS) {
        expect(parseAssetName('ios', assetNameFor('ios', locale, deviceSlug))).toEqual({ locale, deviceSlug });
      }
    }
  });

  it('returns null for anything that is not a known shard', () => {
    expect(parseAssetName('ios', 'ios-manifest.json')).toBeNull();
    expect(parseAssetName('ios', 'ios-pt-BR-iphone-16-pro-max.zip')).toBeNull();
  });
});

describe('assertCompleteTree', () => {
  it('accepts the full five-locale, three-device set', () => {
    expect(() => assertCompleteTree(completeTree())).not.toThrow();
  });

  it.each([...EXPECTED_APP_STORE_LOCALES])('refuses a tree missing %s', (locale) => {
    const tree = completeTree();
    delete tree[locale];
    expect(() => assertCompleteTree(tree)).toThrow(new RegExp(`missing locale directory ${locale}`));
  });

  it.each([...EXPECTED_APP_STORE_DEVICE_SLUGS])('refuses a tree missing the %s folder', (deviceSlug) => {
    const tree = completeTree();
    delete tree['fr-FR'][deviceSlug];
    expect(() => assertCompleteTree(tree)).toThrow(new RegExp(`missing device directory fr-FR/${deviceSlug}`));
  });

  it('refuses a shard folder with no PNGs', () => {
    const tree = completeTree();
    tree['de-DE']['iphone-16-pro-max'] = [];
    expect(() => assertCompleteTree(tree)).toThrow(/no PNGs in de-DE\/iphone-16-pro-max/);
  });

  it('refuses a tree with an unknown locale directory', () => {
    const tree = completeTree();
    tree['pt-BR'] = { 'iphone-16-pro-max': ['01-discover.png'] };
    expect(() => assertCompleteTree(tree)).toThrow(/unknown locale directory pt-BR/);
  });

  it('refuses a tree with an unknown device directory in a known locale', () => {
    const tree = completeTree();
    tree['en-US']['iphone-14-plus'] = ['01-discover.png'];
    expect(() => assertCompleteTree(tree)).toThrow(/unknown device directory en-US\/iphone-14-plus/);
  });
});

describe('verifyShardAgainstManifest', () => {
  const manifest: BaselineManifest = {
    platform: 'ios',
    commit: 'deadbeef',
    runId: '7',
    capturedAt: '2026-09-08T00:00:00.000Z',
    files: {
      'en-US/iphone-16-pro-max/01-discover.png': 'aa'.repeat(32),
      'en-US/iphone-16-pro-max/02-board.png': 'bb'.repeat(32),
    },
  };

  it('reports ok when every hash matches the manifest', () => {
    const result = verifyShardAgainstManifest(manifest, '/shard', 'en-US', 'iphone-16-pro-max', {
      '01-discover.png': 'aa'.repeat(32),
      '02-board.png': 'bb'.repeat(32),
    });
    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('flags a file whose hash no longer matches the manifest', () => {
    const result = verifyShardAgainstManifest(manifest, '/shard', 'en-US', 'iphone-16-pro-max', {
      '01-discover.png': 'ff'.repeat(32),
      '02-board.png': 'bb'.repeat(32),
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain(join('/shard', '01-discover.png'));
    expect(result.problems[0]).toContain('does not match the manifest');
  });

  it('flags a file the manifest never listed', () => {
    const result = verifyShardAgainstManifest(manifest, '/shard', 'en-US', 'iphone-16-pro-max', {
      '01-discover.png': 'aa'.repeat(32),
      '03-extra.png': 'cc'.repeat(32),
    });
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain(join('/shard', '03-extra.png'));
    expect(result.problems[0]).toContain('is not listed in the manifest');
  });
});

describe('buildManifest', () => {
  it('records the capture identity and sorts the file hashes', () => {
    const manifest = buildManifest({
      platform: 'ios',
      commit: 'abc123',
      runId: '42',
      capturedAt: '2026-09-08T00:00:00.000Z',
      files: [
        { relativePath: 'fr-FR/iphone-16-pro-max/01-discover.png', sha256: 'ff' },
        { relativePath: 'en-US/iphone-16-pro-max/01-discover.png', sha256: 'aa' },
      ],
    });

    expect(manifest.platform).toBe('ios');
    expect(manifest.commit).toBe('abc123');
    expect(manifest.runId).toBe('42');
    expect(manifest.capturedAt).toBe('2026-09-08T00:00:00.000Z');
    expect(Object.keys(manifest.files)).toEqual([
      'en-US/iphone-16-pro-max/01-discover.png',
      'fr-FR/iphone-16-pro-max/01-discover.png',
    ]);
  });
});

describe('packBaseline', () => {
  it('zips every shard flat and writes a manifest that covers all 30 files', () => {
    const tree = writeTree(join(workDir, 'tree'));
    const runner = new FakeRunner();

    const packed = packBaseline({
      platform: 'ios',
      treeDir: tree,
      outDir: join(workDir, 'out'),
      commit: 'deadbeef',
      runId: '7',
      capturedAt: '2026-09-08T00:00:00.000Z',
      runner,
    });

    expect(packed.zipFiles).toHaveLength(EXPECTED_APP_STORE_LOCALES.length * EXPECTED_APP_STORE_DEVICE_SLUGS.length);
    expect(runner.calls.every((call) => call.command === 'zip')).toBe(true);
    // -j flattens the directory prefix so the archive holds bare NN-name.png.
    expect(runner.calls[0].args.slice(0, 3)).toEqual(['-j', '-X', '-q']);
    expect(runner.calls[0].args[3]).toContain('ios-en-US-iphone-16-pro-max.zip');
    expect(Object.keys(packed.manifest.files)).toHaveLength(30);
    expect(packed.manifest.files['en-US/iphone-16-pro-max/01-discover.png']).toMatch(/^[0-9a-f]{64}$/);

    const written: unknown = JSON.parse(readFileSync(packed.manifestFile, 'utf8'));
    expect(written).toEqual(packed.manifest);
  });

  it('refuses to pack a tree that lost a shard', () => {
    const tree = writeTree(join(workDir, 'tree'), { locale: 'de-DE' });
    expect(() =>
      packBaseline({
        platform: 'ios',
        treeDir: tree,
        outDir: join(workDir, 'out'),
        commit: 'deadbeef',
        runId: '7',
        runner: new FakeRunner(),
      }),
    ).toThrow(/missing locale directory de-DE/);
  });
});

describe('readShardTree', () => {
  it('reads the locale/device/PNG shape back off disk', () => {
    const tree = readShardTree(writeTree(join(workDir, 'tree')));
    expect(Object.keys(tree).sort()).toEqual([...EXPECTED_APP_STORE_LOCALES].sort());
    expect(tree['en-US']['iphone-16-pro-max']).toEqual(['01-discover.png', '02-board.png']);
  });

  it('returns an empty tree for a directory that does not exist', () => {
    expect(readShardTree(join(workDir, 'nope'))).toEqual({});
  });
});

describe('publishBaseline', () => {
  it('creates the prerelease when it is missing and uploads the manifest last', () => {
    const tree = writeTree(join(workDir, 'tree'));
    const runner = new FakeRunner((invocation) =>
      invocation.command === 'gh' && invocation.args[1] === 'view' ? fail() : ok(),
    );

    publishBaseline({
      platform: 'ios',
      treeDir: tree,
      outDir: join(workDir, 'out'),
      commit: 'deadbeef',
      runId: '7',
      runner,
    });

    const ghCalls = runner.calls.filter((call) => call.command === 'gh');
    expect(ghCalls.map((call) => call.args.slice(0, 2))).toEqual([
      ['release', 'view'],
      ['release', 'create'],
      ['release', 'upload'],
      ['release', 'upload'],
    ]);
    expect(ghCalls[1].args).toContain('--prerelease');
    expect(ghCalls[1].args).toContain(BASELINE_TAG);
    // Zips first, manifest last: whoever reads the manifest sees every asset it names.
    expect(ghCalls[2].args.filter((argument) => argument.endsWith('.zip'))).toHaveLength(15);
    expect(ghCalls[2].args).toContain('--clobber');
    expect(ghCalls[3].args.some((argument) => argument.endsWith('ios-manifest.json'))).toBe(true);
  });

  it('reuses an existing prerelease instead of recreating it', () => {
    const tree = writeTree(join(workDir, 'tree'));
    const runner = new FakeRunner(() => ok());

    publishBaseline({
      platform: 'ios',
      treeDir: tree,
      outDir: join(workDir, 'out'),
      commit: 'deadbeef',
      runId: '7',
      runner,
    });

    expect(runner.calls.some((call) => call.command === 'gh' && call.args[1] === 'create')).toBe(false);
  });
});

describe('fetchBaseline', () => {
  it('reports found=false when the release or asset is missing', () => {
    const runner = new FakeRunner((invocation) => (invocation.args[1] === 'download' ? fail() : ok()));

    const result = fetchBaseline({
      platform: 'ios',
      outDir: join(workDir, 'baseline'),
      asset: 'ios-en-US-iphone-16-pro-max.zip',
      all: false,
      runner,
      downloadDir: join(workDir, 'download'),
    });

    expect(result).toEqual({ found: false, commit: '', unzipped: [] });
  });

  it('unzips one shard flat and reports the baseline commit', () => {
    const downloadDir = join(workDir, 'download');
    mkdirSync(downloadDir, { recursive: true });
    writeFileSync(join(downloadDir, 'ios-en-US-iphone-16-pro-max.zip'), 'zip-bytes');
    writeFileSync(
      join(downloadDir, 'ios-manifest.json'),
      JSON.stringify({ platform: 'ios', commit: 'cafebabe', runId: '3', capturedAt: 'now', files: {} }),
    );
    const runner = new FakeRunner(() => ok());
    const outDir = join(workDir, 'baseline');

    const result = fetchBaseline({
      platform: 'ios',
      outDir,
      asset: 'ios-en-US-iphone-16-pro-max.zip',
      all: false,
      runner,
      downloadDir,
    });

    expect(result.found).toBe(true);
    expect(result.commit).toBe('cafebabe');
    const unzip = runner.calls.find((call) => call.command === 'unzip');
    expect(unzip?.args.at(-1)).toBe(outDir);
    const download = runner.calls.find((call) => call.args[1] === 'download');
    expect(download?.args).toContain('ios-en-US-iphone-16-pro-max.zip');
    expect(download?.args).toContain('ios-manifest.json');
  });

  it('discards a fetched shard and reports found=false when a file does not match the manifest', () => {
    const downloadDir = join(workDir, 'download');
    mkdirSync(downloadDir, { recursive: true });
    writeFileSync(join(downloadDir, 'ios-en-US-iphone-16-pro-max.zip'), 'zip-bytes');
    const manifest: BaselineManifest = {
      platform: 'ios',
      commit: 'cafebabe',
      runId: '3',
      capturedAt: 'now',
      files: { 'en-US/iphone-16-pro-max/01-discover.png': 'aa'.repeat(32) },
    };
    writeFileSync(join(downloadDir, 'ios-manifest.json'), JSON.stringify(manifest));
    const outDir = join(workDir, 'baseline');
    // The fake unzip performs a REAL extraction (unlike the other fetchBaseline
    // tests) so the sha256 verification has actual bytes to hash — bytes that
    // deliberately do not match the manifest's recorded hash.
    const runner = new FakeRunner((invocation) => {
      if (invocation.command === 'unzip') {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, '01-discover.png'), 'tampered bytes');
      }
      return ok();
    });

    const result = fetchBaseline({
      platform: 'ios',
      outDir,
      asset: 'ios-en-US-iphone-16-pro-max.zip',
      all: false,
      runner,
      downloadDir,
    });

    expect(result).toEqual({ found: false, commit: '', unzipped: [] });
    expect(existsSync(outDir)).toBe(false);
  });

  it('keeps a fetched shard when its extracted file matches the manifest', () => {
    const downloadDir = join(workDir, 'download');
    mkdirSync(downloadDir, { recursive: true });
    writeFileSync(join(downloadDir, 'ios-en-US-iphone-16-pro-max.zip'), 'zip-bytes');
    const fileBytes = 'real screenshot bytes';
    const expectedSha256 = createHash('sha256').update(fileBytes).digest('hex');
    const manifest: BaselineManifest = {
      platform: 'ios',
      commit: 'cafebabe',
      runId: '3',
      capturedAt: 'now',
      files: { 'en-US/iphone-16-pro-max/01-discover.png': expectedSha256 },
    };
    writeFileSync(join(downloadDir, 'ios-manifest.json'), JSON.stringify(manifest));
    const outDir = join(workDir, 'baseline');
    const runner = new FakeRunner((invocation) => {
      if (invocation.command === 'unzip') {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, '01-discover.png'), fileBytes);
      }
      return ok();
    });

    const result = fetchBaseline({
      platform: 'ios',
      outDir,
      asset: 'ios-en-US-iphone-16-pro-max.zip',
      all: false,
      runner,
      downloadDir,
    });

    expect(result.found).toBe(true);
    expect(existsSync(join(outDir, '01-discover.png'))).toBe(true);
  });

  it('treats an unzip exit code of 1 as a warning, not a failure', () => {
    const downloadDir = join(workDir, 'download');
    mkdirSync(downloadDir, { recursive: true });
    writeFileSync(join(downloadDir, 'ios-en-US-iphone-16-pro-max.zip'), 'zip-bytes');
    // No manifest.json here, so verification is skipped — this test isolates
    // the unzip exit-code handling from the manifest-verification behaviour.
    const runner = new FakeRunner((invocation) =>
      invocation.command === 'unzip'
        ? { status: 1, stdout: '', stderr: '1 warning; stripped leading "../" from an entry' }
        : ok(),
    );

    const result = fetchBaseline({
      platform: 'ios',
      outDir: join(workDir, 'baseline'),
      asset: 'ios-en-US-iphone-16-pro-max.zip',
      all: false,
      runner,
      downloadDir,
    });

    expect(result.found).toBe(true);
  });

  it('fails on an unzip exit code other than 0 or 1', () => {
    const downloadDir = join(workDir, 'download');
    mkdirSync(downloadDir, { recursive: true });
    writeFileSync(join(downloadDir, 'ios-en-US-iphone-16-pro-max.zip'), 'zip-bytes');
    const runner = new FakeRunner((invocation) =>
      invocation.command === 'unzip' ? { status: 2, stdout: '', stderr: 'cannot find zipfile directory' } : ok(),
    );

    expect(() =>
      fetchBaseline({
        platform: 'ios',
        outDir: join(workDir, 'baseline'),
        asset: 'ios-en-US-iphone-16-pro-max.zip',
        all: false,
        runner,
        downloadDir,
      }),
    ).toThrow(/unzip/);
  });

  it('rebuilds the locale/device tree when fetching every shard', () => {
    const downloadDir = join(workDir, 'download');
    mkdirSync(downloadDir, { recursive: true });
    writeFileSync(join(downloadDir, 'ios-en-US-iphone-16-pro-max.zip'), 'zip-bytes');
    writeFileSync(join(downloadDir, 'ios-de-DE-ipad-pro-11-inch-m5.zip'), 'zip-bytes');
    const runner = new FakeRunner(() => ok());
    const outDir = join(workDir, 'baseline');

    const result = fetchBaseline({ platform: 'ios', outDir, asset: null, all: true, runner, downloadDir });

    expect(result.found).toBe(true);
    const unzipTargets = runner.calls.filter((call) => call.command === 'unzip').map((call) => call.args.at(-1));
    expect(unzipTargets).toEqual([
      join(outDir, 'de-DE', 'ipad-pro-11-inch-m5'),
      join(outDir, 'en-US', 'iphone-16-pro-max'),
    ]);
    const download = runner.calls.find((call) => call.args[1] === 'download');
    expect(download?.args).toContain('ios-*.zip');
  });
});

describe('parseBaselineArguments', () => {
  it('parses a publish invocation', () => {
    expect(
      parseBaselineArguments([
        'publish',
        '--platform',
        'ios',
        '--tree',
        'app-stores/apple/screenshots',
        '--commit',
        'abc',
        '--run-id',
        '9',
      ]),
    ).toEqual({
      subcommand: 'publish',
      platform: 'ios',
      treeDir: 'app-stores/apple/screenshots',
      outDir: null,
      commit: 'abc',
      runId: '9',
      asset: null,
      all: false,
    });
  });

  it('accepts --all as a bare flag on fetch', () => {
    const parsed = parseBaselineArguments(['fetch', '--platform', 'ios', '--all', '--out', 'shots']);
    expect(parsed.all).toBe(true);
    expect(parsed.outDir).toBe('shots');
  });

  const invalidInvocations: Array<[string[], RegExp]> = [
    [['pack', '--platform', 'ios', '--out', 'out'], /--tree is required/],
    [['fetch', '--platform', 'ios', '--out', 'out'], /needs --asset <name> or --all/],
    [['fetch', '--platform', 'android', '--all', '--out', 'out'], /--platform must be ios/],
    [['sync', '--platform', 'ios'], /First argument must be one of/],
  ];

  it.each(invalidInvocations)('rejects %j', (argv, message) => {
    expect(() => parseBaselineArguments(argv)).toThrow(message);
  });
});
