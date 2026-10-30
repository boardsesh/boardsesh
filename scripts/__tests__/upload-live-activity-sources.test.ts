/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { importLiveActivityFootage } from '../import-live-activity-footage';
import {
  LIVE_ACTIVITY_FIXTURE_ROOT,
  nativeCaptureSha256,
  readLiveActivityManifest,
  type LiveActivityFootageSource,
} from '../lib/screenshot-live-activity';
import {
  extractSourceArchive,
  selectSourceReleaseAssets,
  uploadLiveActivitySources,
} from '../upload-live-activity-sources';

vi.mock('../import-live-activity-footage', () => ({ importLiveActivityFootage: vi.fn() }));
const directories: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), 'source-release-test-'));
  directories.push(directory);
  return directory;
}
interface ZipEntry {
  name: string;
  contents: string;
  mode?: number;
}
function zip(root: string, entries: ZipEntry[]) {
  const specification = join(root, 'entries.json');
  const archive = join(root, 'archive.zip');
  writeFileSync(specification, JSON.stringify(entries));
  execFileSync(
    'python3',
    [
      '-c',
      `import zipfile,json,sys
with zipfile.ZipFile(sys.argv[2],'w') as archive:
 for supplied in json.load(open(sys.argv[1])):
  entry=zipfile.ZipInfo(supplied['name']); entry.external_attr=supplied.get('mode',0o100644)<<16
  archive.writestr(entry,supplied['contents'].encode())
`,
      specification,
      archive,
    ],
    { stdio: 'ignore' },
  );
  return readFileSync(archive);
}
function entries(names = ['00001.jpg', '00002.jpg']): ZipEntry[] {
  return [
    {
      name: 'source.json',
      contents: JSON.stringify({
        firstFrame: names[0],
        lastFrame: names.at(-1),
        frames: names.map((file, index) => ({ file, receivedSeconds: index * 7 })),
      }),
    },
    ...names.map((name) => ({ name, contents: 'synthetic unit-test JPEG payload' })),
  ];
}
function source(
  target: 'kilter' | 'tension',
  sha256 = (target === 'kilter' ? 'a' : 'b').repeat(64),
): LiveActivityFootageSource {
  const fixture = readLiveActivityManifest().fixtures[`${target}/en-US`];
  return {
    sha256,
    key: `sources/live-activity/${sha256}.zip`,
    boardFamily: target,
    sourceLocale: 'en-US',
    nativeFixtureSourcePngSha256: fixture.sourcePngSha256,
    frameCount: 2,
    durationSeconds: 7,
    reviewedAt: fixture.review.reviewedAt,
    reviewedBy: 'Synthetic source-transport regression',
  };
}
function release(sources = { kilter: source('kilter'), tension: source('tension') }) {
  return {
    id: 123,
    draft: true,
    url: 'https://api.github.com/repos/boardsesh/boardsesh/releases/123',
    assets: Object.values(sources).map((source, index) => ({
      id: index + 1,
      name: `${source.sha256}.zip`,
      size: 100,
      state: 'uploaded',
      url: `https://api.github.com/repos/boardsesh/boardsesh/releases/assets/${index + 1}`,
    })),
  };
}

function scenario() {
  const root = temporary();
  const fixtureRoot = join(root, 'fixtures');
  mkdirSync(fixtureRoot);
  const committed = readLiveActivityManifest();
  const archives = Object.fromEntries(
    (['kilter', 'tension'] as const).map((target) => {
      const directory = join(root, target);
      mkdirSync(directory);
      const contents = entries();
      const metadata = JSON.parse(contents[0].contents) as Record<string, unknown>;
      metadata.target = target;
      contents[0].contents = JSON.stringify(metadata);
      return [target, zip(directory, contents)];
    }),
  ) as Record<'kilter' | 'tension', Buffer>;
  const sources = {
    kilter: source('kilter', nativeCaptureSha256(archives.kilter)),
    tension: source('tension', nativeCaptureSha256(archives.tension)),
  };
  committed.footage = sources;
  writeFileSync(join(fixtureRoot, 'manifest.json'), `${JSON.stringify(committed, null, 2)}\n`);
  for (const fixture of Object.values(committed.fixtures))
    copyFileSync(join(LIVE_ACTIVITY_FIXTURE_ROOT, fixture.file), join(fixtureRoot, fixture.file));
  const transport = release(sources);
  for (const asset of transport.assets) asset.size = archives[asset.id === 1 ? 'kilter' : 'tension'].length;
  const events: string[] = [];
  const github = {
    release: vi.fn(() => transport),
    download: vi.fn((_repository: string, asset: { target: 'kilter' | 'tension' }, destination: string) => {
      events.push(`download:${asset.target}`);
      writeFileSync(destination, archives[asset.target]);
    }),
  };
  const store = {
    head: vi.fn(async () => false),
    put: vi.fn(async (key: string) => {
      events.push(`put:${key}`);
    }),
  };
  const publicSha256 = vi.fn(async (url: string) => {
    events.push(`public:${url}`);
    return url.includes(sources.kilter.sha256) ? sources.kilter.sha256 : sources.tension.sha256;
  });
  vi.mocked(importLiveActivityFootage).mockImplementation(async (input, _provenance, _fixtureRoot, upload) => {
    const { target } = JSON.parse(readFileSync(join(input, 'source.json'), 'utf8')) as { target: 'kilter' | 'tension' };
    events.push(`validate:${target}`);
    await upload!(sources[target].key, archives[target]);
    return sources[target];
  });
  return { fixtureRoot, sources, transport, archives, github, store, publicSha256, events };
}

describe('reviewed physical source release transport', () => {
  it('accepts only the two hash-named same-repository draft assets', () => {
    const selected = selectSourceReleaseAssets(release(), 'boardsesh/boardsesh', '123', {
      kilter: source('kilter'),
      tension: source('tension'),
    });
    expect(selected.map((asset) => asset.target)).toEqual(['kilter', 'tension']);
  });
  it.each(['../123', '123;echo secret', '0', '1.0', 'https://example.com', '9007199254740992'])(
    'rejects a non-numeric release selector: %s',
    (releaseId) => {
      expect(() =>
        selectSourceReleaseAssets(release(), 'boardsesh/boardsesh', releaseId, {
          kilter: source('kilter'),
          tension: source('tension'),
        }),
      ).toThrow('numeric');
    },
  );
  it.each(['published', 'foreign', 'wrong-name', 'duplicate-name', 'oversized', 'foreign-asset', 'uploading'])(
    'rejects an untrusted or incomplete transport: %s',
    (failure) => {
      const document = release();
      if (failure === 'published') document.draft = false;
      if (failure === 'foreign') document.url = 'https://api.github.com/repos/attacker/other/releases/123';
      if (failure === 'wrong-name') document.assets[0].name = 'kilter.zip';
      if (failure === 'duplicate-name') document.assets[1].name = document.assets[0].name;
      if (failure === 'oversized') document.assets[0].size = 1024 ** 3 + 1;
      if (failure === 'foreign-asset') document.assets[0].url = 'https://example.com/source.zip';
      if (failure === 'uploading') document.assets[0].state = 'new';
      expect(() =>
        selectSourceReleaseAssets(document, 'boardsesh/boardsesh', '123', {
          kilter: source('kilter'),
          tension: source('tension'),
        }),
      ).toThrow();
    },
  );
  it('verifies the committed archive SHA before attempting extraction', async () => {
    const root = temporary();
    const archive = join(root, 'untrusted.zip');
    writeFileSync(archive, 'not a ZIP');
    await expect(extractSourceArchive(archive, 'a'.repeat(64), join(root, 'output'))).rejects.toThrow('SHA-256');
    expect(existsSync(join(root, 'output'))).toBe(false);
  });
  it.each(['path', 'duplicate', 'numeric-alias', 'gap', 'symlink', 'bomb', 'unlisted-frame'])(
    'rejects unsafe archive contents before extracting any frame: %s',
    async (failure) => {
      const root = temporary();
      const contents =
        failure === 'numeric-alias'
          ? entries(['1.jpg', '01.jpg'])
          : failure === 'gap'
            ? entries(['00001.jpg', '00003.jpg'])
            : entries();
      if (failure === 'path') contents.push({ name: '../escape.jpg', contents: 'no' });
      if (failure === 'duplicate') contents.push(contents[1]);
      if (failure === 'symlink') contents[1].mode = 0o120777;
      if (failure === 'unlisted-frame') contents.push({ name: '00003.jpg', contents: 'not in provenance' });
      const archive = zip(root, contents);
      if (failure === 'bomb')
        archive.writeUInt32LE(1024 ** 3 + 1, archive.indexOf(Buffer.from('PK\x01\x02', 'binary')) + 24);
      writeFileSync(join(root, 'archive.zip'), archive);
      await expect(
        extractSourceArchive(join(root, 'archive.zip'), nativeCaptureSha256(archive), join(root, 'output')),
      ).rejects.toThrow();
      expect(existsSync(join(root, 'output'))).toBe(false);
      expect(existsSync(join(root, 'escape.jpg'))).toBe(false);
    },
  );
  it('extracts the exact contiguous archive bytes after hash verification', async () => {
    const root = temporary();
    const archive = zip(root, entries());
    await extractSourceArchive(join(root, 'archive.zip'), nativeCaptureSha256(archive), join(root, 'output'));
    expect(readFileSync(join(root, 'output/00001.jpg'), 'utf8')).toBe('synthetic unit-test JPEG payload');
  });
  it('validates both originals before R2 writes and preserves committed manifest bytes', async () => {
    const options = scenario();
    const manifest = readFileSync(join(options.fixtureRoot, 'manifest.json'));
    await uploadLiveActivitySources({ repository: 'boardsesh/boardsesh', releaseId: '123', ...options });
    expect(options.events.slice(0, 4)).toEqual([
      'download:kilter',
      'download:tension',
      'validate:kilter',
      'validate:tension',
    ]);
    expect(options.store.put).toHaveBeenCalledTimes(2);
    expect(options.publicSha256).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(options.fixtureRoot, 'manifest.json'))).toEqual(manifest);
  });
  it('makes no R2 writes when the second archive hash differs', async () => {
    const options = scenario();
    options.archives.tension[0] ^= 1;
    await expect(
      uploadLiveActivitySources({ repository: 'boardsesh/boardsesh', releaseId: '123', ...options }),
    ).rejects.toThrow('SHA-256');
    expect(importLiveActivityFootage).not.toHaveBeenCalled();
    expect(options.store.head).not.toHaveBeenCalled();
    expect(options.store.put).not.toHaveBeenCalled();
  });
  it('rejects a canonical repack mismatch before R2 writes', async () => {
    const options = scenario();
    vi.mocked(importLiveActivityFootage).mockImplementationOnce(async (_input, _metadata, _root, upload) => {
      await upload!(options.sources.kilter.key, Buffer.from('changed canonical source'));
      return options.sources.kilter;
    });
    await expect(
      uploadLiveActivitySources({ repository: 'boardsesh/boardsesh', releaseId: '123', ...options }),
    ).rejects.toThrow('Revalidated source');
    expect(options.store.put).not.toHaveBeenCalled();
  });
  it('rejects changed source metadata before R2 writes', async () => {
    const options = scenario();
    vi.mocked(importLiveActivityFootage).mockImplementationOnce(async (_input, _metadata, _root, upload) => {
      await upload!(options.sources.kilter.key, options.archives.kilter);
      return { ...options.sources.kilter, reviewedBy: 'different review' };
    });
    await expect(
      uploadLiveActivitySources({ repository: 'boardsesh/boardsesh', releaseId: '123', ...options }),
    ).rejects.toThrow('changed the reviewed');
    expect(options.store.put).not.toHaveBeenCalled();
  });
  it('checks public bytes even when immutable source objects already exist', async () => {
    const options = scenario();
    options.store.head.mockResolvedValue(true);
    options.publicSha256.mockResolvedValue('0'.repeat(64));
    await expect(
      uploadLiveActivitySources({ repository: 'boardsesh/boardsesh', releaseId: '123', ...options }),
    ).rejects.toThrow('Public R2 SHA-256');
    expect(options.store.put).not.toHaveBeenCalled();
  });
  it('keeps the workflow manual, main-only, read-only, bounded and separate from Apple writes', () => {
    const workflow = parse(readFileSync('.github/workflows/mobile-live-activity-import.yml', 'utf8')) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: {
        import: {
          if: string;
          environment: string;
          'timeout-minutes': number;
          steps: { uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> }[];
        };
      };
    };
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const job = workflow.jobs.import;
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe('Production');
    expect(job['timeout-minutes']).toBe(15);
    expect(job.steps[0].with).toEqual({ ref: '${{ github.sha }}', 'persist-credentials': false });
    expect(job.steps[1].with?.cache).toBe(false);
    const command = job.steps.find((step) => step.run?.includes('upload-live-activity-sources.ts'))!;
    expect(command.env?.SOURCE_RELEASE_ID).toBe('${{ inputs.release_id }}');
    expect(command.run).not.toContain('${{');
    expect(JSON.stringify(workflow)).not.toContain('APP_STORE_CONNECT');
    expect(command.run).toContain('git diff --exit-code');
  });
});
