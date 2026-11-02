/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { importLiveActivityFootage } from './import-live-activity-footage';
import {
  createCreativeStore,
  createStoreCreativesClient,
  parseCreativeManifest,
  type CreativeStore,
} from './store-creatives-r2';
import {
  LIVE_ACTIVITY_FIXTURE_ROOT,
  LIVE_ACTIVITY_MANIFEST,
  nativeCaptureSha256,
  readLiveActivityManifest,
  type LiveActivityFootageSource,
} from './lib/screenshot-live-activity';

const MAX_BYTES = 1024 ** 3;
const TARGETS = ['kilter', 'tension'] as const;
type Target = (typeof TARGETS)[number];
interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  target: Target;
  sha256: string;
}
interface SourceGitHub {
  release(this: void, repository: string, releaseId: string): unknown;
  download(this: void, repository: string, asset: ReleaseAsset, destination: string): void;
}
function record(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

export function selectSourceReleaseAssets(
  release: unknown,
  repository: string,
  releaseId: string,
  sources: Record<Target, LiveActivityFootageSource>,
): ReleaseAsset[] {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !/^[1-9]\d*$/.test(releaseId) ||
    !Number.isSafeInteger(Number(releaseId))
  )
    throw new Error('Need a same-repository numeric draft release ID');
  if (
    !record(release) ||
    release.id !== Number(releaseId) ||
    release.draft !== true ||
    release.url !== `https://api.github.com/repos/${repository}/releases/${releaseId}` ||
    !Array.isArray(release.assets) ||
    release.assets.length !== 2
  )
    throw new Error('Transport must be a same-repository draft release containing exactly two source ZIPs');
  const releaseAssets: unknown[] = release.assets;
  return TARGETS.map((target) => {
    const expected = sources[target];
    const name = `${expected.sha256}.zip`;
    const matches = releaseAssets.filter((asset) => record(asset) && asset.name === name);
    const asset = matches[0];
    if (
      matches.length !== 1 ||
      !record(asset) ||
      !Number.isSafeInteger(asset.id) ||
      Number(asset.id) < 1 ||
      asset.url !== `https://api.github.com/repos/${repository}/releases/assets/${Number(asset.id)}` ||
      asset.state !== 'uploaded' ||
      !Number.isSafeInteger(asset.size) ||
      Number(asset.size) < 1 ||
      Number(asset.size) > MAX_BYTES
    )
      throw new Error(`Draft release needs one uploaded ${target} ZIP matching the committed SHA and size limit`);
    return { target, id: Number(asset.id), name, size: Number(asset.size), sha256: expected.sha256 };
  });
}

async function fileSha256(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

const extractPython = `import sys,zipfile,pathlib,json,re,stat
archive_path,output=sys.argv[1:]
root=pathlib.Path(output)
with zipfile.ZipFile(archive_path) as archive:
 entries=archive.infolist(); names=[entry.filename for entry in entries]
 if len(names)!=len(set(names)) or 'source.json' not in names or not 2<=len(names)<=30001: raise ValueError('Invalid source archive entries')
 if any(name!='source.json' and not re.fullmatch(r'[0-9]+[.]jpg',name) for name in names): raise ValueError('Unsafe source archive entry')
 if any(entry.flag_bits&1 or stat.S_IFMT(entry.external_attr>>16) not in (0,stat.S_IFREG) for entry in entries): raise ValueError('Source archive entries must be plain unencrypted files')
 if sum(entry.file_size for entry in entries)>${MAX_BYTES}: raise ValueError('Source archive exceeds 1 GiB')
 frames=[name for name in names if name!='source.json']; numbers=sorted(int(name[:-4]) for name in frames)
 if len(set(numbers))!=len(numbers) or numbers!=list(range(numbers[0],numbers[0]+len(numbers))): raise ValueError('Source archive JPEG numbering has gaps or duplicates')
 if archive.getinfo('source.json').file_size>16*1024*1024: raise ValueError('Source provenance exceeds 16 MiB')
 source=json.loads(archive.read('source.json'))
 if not isinstance(source,dict) or not isinstance(source.get('frames'),list) or len(source['frames'])!=len(frames): raise ValueError('Source provenance must name every JPEG')
 described=[frame.get('file') if isinstance(frame,dict) else None for frame in source['frames']]
 if len(set(described))!=len(described) or set(described)!=set(frames) or described[0]!=source.get('firstFrame') or described[-1]!=source.get('lastFrame'): raise ValueError('Source provenance differs from archive frame range')
 root.mkdir()
 for entry in entries:
  copied=0
  with archive.open(entry) as original, (root/entry.filename).open('xb') as destination:
   while True:
    chunk=original.read(1024*1024)
    if not chunk: break
    copied+=len(chunk)
    if copied>entry.file_size or copied>${MAX_BYTES}: raise ValueError('Source entry exceeds declared size')
    destination.write(chunk)
  if copied!=entry.file_size: raise ValueError('Incomplete source entry')
`;

export async function extractSourceArchive(archivePath: string, expectedSha256: string, output: string): Promise<void> {
  if (
    !/^[a-f0-9]{64}$/.test(expectedSha256) ||
    statSync(archivePath).size > MAX_BYTES ||
    (await fileSha256(archivePath)) !== expectedSha256
  )
    throw new Error('Transport ZIP SHA-256 or size differs from the committed source');
  execFileSync('python3', ['-c', extractPython, archivePath, output], {
    timeout: 60_000,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

const github: SourceGitHub = {
  release(repository, releaseId) {
    return JSON.parse(
      execFileSync('gh', ['api', `repos/${repository}/releases/${releaseId}`], { encoding: 'utf8', timeout: 30_000 }),
    );
  },
  download(repository, asset, destination) {
    const descriptor = openSync(destination, 'wx');
    try {
      execFileSync(
        'gh',
        ['api', `repos/${repository}/releases/assets/${asset.id}`, '--header', 'Accept: application/octet-stream'],
        { timeout: 120_000, stdio: ['ignore', descriptor, 'pipe'] },
      );
    } finally {
      closeSync(descriptor);
    }
  },
};

async function publicSha256(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Public source verification failed (HTTP ${response.status})`);
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) throw new Error('Public source exceeds 1 GiB');
    digest.update(chunk);
  }
  return digest.digest('hex');
}

export async function uploadLiveActivitySources(options: {
  repository: string;
  releaseId: string;
  fixtureRoot?: string;
  creativeManifest?: string;
  github?: SourceGitHub;
  store?: Pick<CreativeStore, 'head' | 'put'>;
  publicSha256?: (url: string) => Promise<string>;
}): Promise<void> {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(options.repository) ||
    !/^[1-9]\d*$/.test(options.releaseId) ||
    !Number.isSafeInteger(Number(options.releaseId))
  )
    throw new Error('Need a same-repository numeric draft release ID');
  const fixtureRoot = options.fixtureRoot ?? LIVE_ACTIVITY_FIXTURE_ROOT;
  const manifestBytes = readFileSync(join(fixtureRoot, LIVE_ACTIVITY_MANIFEST));
  const committed = readLiveActivityManifest(fixtureRoot);
  if (!committed.footage?.kilter || !committed.footage.tension)
    throw new Error('Both reviewed source identities must be committed before uploading');
  const sources = { kilter: committed.footage.kilter, tension: committed.footage.tension };
  const storage = parseCreativeManifest(
    JSON.parse(readFileSync(options.creativeManifest ?? 'app-stores/apple/creative-assets.json', 'utf8')),
  ).storage;
  const transport = options.github ?? github;
  const assets = selectSourceReleaseAssets(
    transport.release(options.repository, options.releaseId),
    options.repository,
    options.releaseId,
    sources,
  );
  const temporary = mkdtempSync(join(tmpdir(), 'live-source-upload-'));
  try {
    const root = join(temporary, 'fixtures');
    mkdirSync(root);
    writeFileSync(join(root, LIVE_ACTIVITY_MANIFEST), manifestBytes);
    for (const fixture of Object.values(committed.fixtures))
      copyFileSync(join(fixtureRoot, fixture.file), join(root, fixture.file));
    // Validate both transport hashes before extracting or accessing R2 credentials.
    for (const asset of assets) {
      const archive = join(temporary, asset.name);
      transport.download(options.repository, asset, archive);
      if (statSync(archive).size !== asset.size || (await fileSha256(archive)) !== asset.sha256)
        throw new Error(`Transport ZIP SHA-256 or size differs for ${asset.target}`);
    }
    const validated: { source: LiveActivityFootageSource; archive: string }[] = [];
    for (const asset of assets) {
      const extracted = join(temporary, asset.target);
      await extractSourceArchive(join(temporary, asset.name), asset.sha256, extracted);
      const canonical = join(temporary, `${asset.target}-validated.zip`);
      const retained = await importLiveActivityFootage(
        extracted,
        join(extracted, 'source.json'),
        root,
        async (key, bytes) => {
          if (key !== sources[asset.target].key || nativeCaptureSha256(bytes) !== asset.sha256)
            throw new Error(`Revalidated source differs from committed ${asset.target} identity`);
          writeFileSync(canonical, bytes);
        },
      );
      if (
        !isDeepStrictEqual(retained, sources[asset.target]) ||
        !isDeepStrictEqual(readLiveActivityManifest(root), committed)
      )
        throw new Error(`Import changed the reviewed ${asset.target} manifest`);
      validated.push({ source: retained, archive: canonical });
    }
    if (!readFileSync(join(fixtureRoot, LIVE_ACTIVITY_MANIFEST)).equals(manifestBytes))
      throw new Error('Committed fixture manifest changed during validation');
    const store = options.store ?? createCreativeStore(createStoreCreativesClient());
    for (const { source, archive } of validated) {
      if (!(await store.head(source.key))) await store.put(source.key, readFileSync(archive), 'application/zip');
      const url = new URL(`${storage.baseUrl}/${source.key}`);
      if ((await (options.publicSha256 ?? publicSha256)(url.href)) !== source.sha256)
        throw new Error(`Public R2 SHA-256 verification failed for ${source.boardFamily}`);
      console.log(`Verified reviewed ${source.boardFamily} source ${source.sha256}`);
    }
    if (!readFileSync(join(fixtureRoot, LIVE_ACTIVITY_MANIFEST)).equals(manifestBytes))
      throw new Error('Committed fixture manifest changed during upload');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  uploadLiveActivitySources({
    repository: process.env.GITHUB_REPOSITORY ?? '',
    releaseId: process.env.SOURCE_RELEASE_ID ?? '',
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Source upload failed');
    process.exitCode = 1;
  });
}
