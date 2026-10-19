/// <reference types="node" />

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export const STORE_CREATIVES_BUCKET = 'boardsesh-store-creatives';
const CREATIVE_ROOT = '.boardsesh/app-store-creatives';
const SHA256 = /^[a-f0-9]{64}$/;
export interface CreativeAsset {
  locale: string;
  placement: 'header' | 'search-results';
  file: string;
  sha256: string;
  provenance: string;
  provenanceSha256: string;
  specId: string;
  placementGroup: string;
  poster?: string;
  posterSha256?: string;
}
export interface CreativeManifest {
  schemaVersion: 1;
  storage: { bucket: string; baseUrl: string };
  locales: Record<string, string[]>;
  variants: Record<string, { cpp: string | null; assets: CreativeAsset[] }>;
}
export interface CreativeObject {
  file: string;
  sha256: string;
  extension: string;
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid creative manifest object');
  return input as Record<string, unknown>;
}
function textField(input: unknown): string {
  if (typeof input !== 'string' || !input) throw new Error('Invalid creative manifest string');
  return input;
}
function hashField(input: unknown): string {
  const hash = textField(input);
  if (!SHA256.test(hash)) throw new Error('Invalid creative SHA256');
  return hash;
}
export function sha256Creative(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function creativeObjectKey(
  prefix: 'candidates' | 'approved' | 'sources/live-activity',
  sha: string,
  extension: string,
): string {
  if (!SHA256.test(sha) || !['mp4', 'png', 'jpg', 'json', 'zip'].includes(extension))
    throw new Error('Invalid creative object identity');
  return `${prefix}/${sha}.${extension}`;
}
function creativePath(file: string, variant: string, locale: string, extension: string): string {
  const expected = `${CREATIVE_ROOT}/${variant}/${locale}/`;
  if (
    !file.startsWith(expected) ||
    file.slice(expected.length).includes('/') ||
    file.includes('\\') ||
    extname(file) !== `.${extension}`
  ) {
    throw new Error(`Creative path must stay inside ${expected}`);
  }
  return file;
}
export function parseCreativeManifest(input: unknown): CreativeManifest {
  const manifest = record(input);
  if (manifest.schemaVersion !== 1 || 'release' in manifest) throw new Error('Unsupported creative manifest schema');
  const storage = record(manifest.storage);
  const baseUrl = new URL(textField(storage.baseUrl));
  if (
    storage.bucket !== STORE_CREATIVES_BUCKET ||
    baseUrl.protocol !== 'https:' ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    baseUrl.pathname !== '/'
  )
    throw new Error('Invalid creative storage');
  const locales: Record<string, string[]> = {};
  for (const [locale, storeLocales] of Object.entries(record(manifest.locales))) {
    if (
      !['en-US', 'es', 'fr', 'de'].includes(locale) ||
      !Array.isArray(storeLocales) ||
      !storeLocales.length ||
      storeLocales.some((item) => typeof item !== 'string' || !item)
    )
      throw new Error('Invalid creative locales');
    locales[locale] = storeLocales as string[];
  }
  if (Object.keys(locales).length !== 4) throw new Error('Creative manifest needs all four app locales');
  const variants: CreativeManifest['variants'] = {};
  for (const [variant, inputConfig] of Object.entries(record(manifest.variants))) {
    if (!['default', 'kilter', 'tension', 'moonboard', 'spray'].includes(variant))
      throw new Error('Invalid creative variant');
    const config = record(inputConfig);
    if (!Array.isArray(config.assets) || !(config.cpp === null || typeof config.cpp === 'string'))
      throw new Error('Invalid creative variant configuration');
    const identities = new Set<string>();
    const assets = config.assets.map((inputAsset): CreativeAsset => {
      const asset = record(inputAsset);
      const locale = textField(asset.locale);
      if (!(locale in locales) || !['header', 'search-results'].includes(textField(asset.placement)))
        throw new Error('Invalid creative asset identity');
      const placement = asset.placement as CreativeAsset['placement'];
      const identity = `${locale}/${placement}`;
      if (identities.has(identity)) throw new Error(`Duplicate creative asset ${variant}/${identity}`);
      identities.add(identity);
      const result: CreativeAsset = {
        locale,
        placement,
        file: creativePath(textField(asset.file), variant, locale, placement === 'header' ? 'png' : 'mp4'),
        sha256: hashField(asset.sha256),
        provenance: creativePath(textField(asset.provenance), variant, locale, 'json'),
        provenanceSha256: hashField(asset.provenanceSha256),
        specId: textField(asset.specId),
        placementGroup: textField(asset.placementGroup),
      };
      if (asset.poster !== undefined || asset.posterSha256 !== undefined) {
        result.poster = creativePath(textField(asset.poster), variant, locale, 'jpg');
        result.posterSha256 = hashField(asset.posterSha256);
      }
      return result;
    });
    variants[variant] = { cpp: config.cpp as string | null, assets };
  }
  if (Object.keys(variants).length !== 5) throw new Error('Creative manifest needs all five variants');
  return { schemaVersion: 1, storage: { bucket: STORE_CREATIVES_BUCKET, baseUrl: baseUrl.origin }, locales, variants };
}
export function creativeObjects(manifest: CreativeManifest, variant = 'all', placement = 'all'): CreativeObject[] {
  if (!['all', 'search', 'header'].includes(placement)) throw new Error('Unknown creative placement');
  const selected = variant === 'all' ? Object.keys(manifest.variants) : [variant];
  const objects = new Map<string, CreativeObject>();
  for (const name of selected) {
    if (!manifest.variants[name]) throw new Error('Unknown creative variant');
    for (const asset of manifest.variants[name].assets) {
      if (placement !== 'all' && asset.placement !== (placement === 'search' ? 'search-results' : 'header')) continue;
      const entries = [
        { file: asset.file, sha256: asset.sha256, extension: asset.placement === 'header' ? 'png' : 'mp4' },
        { file: asset.provenance, sha256: asset.provenanceSha256, extension: 'json' },
        ...(asset.poster ? [{ file: asset.poster, sha256: asset.posterSha256!, extension: 'jpg' }] : []),
      ];
      for (const entry of entries) {
        const previous = objects.get(entry.file);
        if (previous && previous.sha256 !== entry.sha256) throw new Error('Conflicting creative destination');
        objects.set(entry.file, entry);
      }
    }
  }
  if (!objects.size) throw new Error('No finalized creative assets selected');
  return [...objects.values()];
}
export function createStoreCreativesClient(environment: NodeJS.ProcessEnv = process.env): S3Client {
  function required(suffix: string): string {
    const name = `STORE_CREATIVES_R2_${suffix}`;
    const setting = environment[name];
    if (!setting) throw new Error(`Missing ${name}`);
    return setting;
  }
  const endpoint = required('AWS_ENDPOINT_URL');
  const endpointUrl = new URL(endpoint);
  if (
    endpointUrl.protocol !== 'https:' ||
    !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(endpointUrl.hostname) ||
    endpointUrl.username ||
    endpointUrl.password ||
    endpointUrl.port ||
    endpointUrl.pathname !== '/' ||
    endpointUrl.search ||
    endpointUrl.hash
  )
    throw new Error('STORE_CREATIVES_R2_AWS_ENDPOINT_URL must be the HTTPS R2 account endpoint');
  return new S3Client({
    endpoint,
    region: 'auto',
    credentials: { accessKeyId: required('AWS_ACCESS_KEY_ID'), secretAccessKey: required('AWS_SECRET_ACCESS_KEY') },
    maxAttempts: 5,
    retryMode: 'adaptive',
  });
}
export interface CreativeStore {
  head(this: void, key: string): Promise<boolean>;
  put(this: void, key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  copy(this: void, source: string, destination: string): Promise<void>;
  get(this: void, key: string): Promise<Uint8Array>;
}
export function createCreativeStore(client: S3Client, bucket = STORE_CREATIVES_BUCKET): CreativeStore {
  return {
    async head(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (error) {
        const failure = error as { $metadata?: { httpStatusCode?: number }; name?: string };
        if (failure.$metadata?.httpStatusCode === 404 || failure.name === 'NotFound' || failure.name === 'NoSuchKey')
          return false;
        throw error;
      }
    },
    async put(key, bytes, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    },
    async copy(source, destination) {
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: destination,
          CopySource: `${bucket}/${source}`,
          MetadataDirective: 'COPY',
        }),
      );
    },
    async get(key) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!response.Body) throw new Error(`Empty R2 response for ${key}`);
      return response.Body.transformToByteArray();
    },
  };
}
export async function runCreativeStorage(options: {
  action: 'upload-candidates' | 'promote' | 'fetch';
  manifest: CreativeManifest;
  store: CreativeStore;
  root?: string;
  output?: string;
  variant?: string;
  placement?: string;
  dryRun?: boolean;
}): Promise<{ objects: number; changed: number }> {
  const objects = creativeObjects(options.manifest, options.variant, options.placement);
  const root = resolve(options.root ?? '.');
  const output = resolve(options.output ?? join(root, CREATIVE_ROOT));
  if (
    options.action === 'fetch' &&
    (output === root || relative(output, root) === '' || !relative(output, root).startsWith('..'))
  )
    throw new Error('Fetch output must not contain the repository root');
  let changed = 0;
  // Validate every local input before publishing anything.
  const localBytes = new Map<string, Uint8Array>();
  if (options.action === 'upload-candidates') {
    for (const object of objects) {
      const source = realpathSync(join(root, object.file));
      if (!source.startsWith(`${realpathSync(root)}${sep}`)) throw new Error('Creative source escapes repository');
      const bytes = readFileSync(source);
      if (sha256Creative(bytes) !== object.sha256) throw new Error(`Creative SHA256 mismatch: ${object.file}`);
      localBytes.set(object.file, bytes);
    }
  }
  if (options.dryRun && options.action !== 'promote') return { objects: objects.length, changed: 0 };
  try {
    for (const object of objects) {
      const candidate = creativeObjectKey('candidates', object.sha256, object.extension);
      const approved = creativeObjectKey('approved', object.sha256, object.extension);
      if (options.action === 'upload-candidates') {
        if (await options.store.head(candidate)) continue;
        await options.store.put(
          candidate,
          localBytes.get(object.file)!,
          { mp4: 'video/mp4', png: 'image/png', jpg: 'image/jpeg', json: 'application/json' }[object.extension] ??
            'application/octet-stream',
        );
      } else if (options.action === 'promote') {
        if (await options.store.head(approved)) continue;
        if (!(await options.store.head(candidate)))
          throw new Error(`Candidate expired or missing: ${candidate}; regenerate this train's videos before merging.`);
        if (options.dryRun) continue;
        await options.store.copy(candidate, approved);
      } else {
        const bytes = await options.store.get(approved);
        if (sha256Creative(bytes) !== object.sha256) throw new Error(`Creative SHA256 mismatch: ${approved}`);
        const destination = join(output, object.file.slice(`${CREATIVE_ROOT}/`.length));
        let ancestor = dirname(destination);
        while (!existsSync(ancestor) && !lstatExists(ancestor)) ancestor = dirname(ancestor);
        if (
          realpathSync(ancestor) !== ancestor ||
          (lstatExists(destination) && lstatSync(destination).isSymbolicLink())
        )
          throw new Error('Creative destination follows a symlink');
        mkdirSync(dirname(destination), { recursive: true });
        if (!realpathSync(dirname(destination)).startsWith(`${realpathSync(output)}${sep}`))
          throw new Error('Creative destination escapes output');
        writeFileSync(destination, bytes);
      }
      changed++;
    }
  } catch (error) {
    if (options.action === 'fetch') rmSync(output, { recursive: true, force: true });
    throw error;
  }
  return { objects: objects.length, changed };
}
function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function main(): Promise<void> {
  const [action, ...args] = process.argv.slice(2).filter((argument) => argument !== '--');
  if (!['upload-candidates', 'promote', 'fetch'].includes(action))
    throw new Error(
      'Usage: store-creatives-r2.ts upload-candidates|promote|fetch --manifest PATH [--root PATH] [--output PATH] [--variant all|NAME] [--placement all|search|header] [--dry-run]',
    );
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--dry-run') {
      flags.set(flag, 'true');
      continue;
    }
    if (
      !['--manifest', '--root', '--output', '--variant', '--placement'].includes(flag) ||
      !args[index + 1] ||
      args[index + 1].startsWith('--') ||
      flags.has(flag)
    )
      throw new Error(`Invalid argument ${flag}`);
    flags.set(flag, args[++index]);
  }
  const manifest = parseCreativeManifest(
    JSON.parse(readFileSync(flags.get('--manifest') ?? 'app-stores/apple/creative-assets.json', 'utf8')),
  );
  const dryRun = flags.has('--dry-run');
  const store =
    dryRun && action !== 'promote'
      ? ({} as CreativeStore)
      : createCreativeStore(createStoreCreativesClient(), manifest.storage.bucket);
  console.log(
    JSON.stringify(
      await runCreativeStorage({
        action: action as 'upload-candidates' | 'promote' | 'fetch',
        manifest,
        store,
        root: flags.get('--root'),
        output: flags.get('--output'),
        variant: flags.get('--variant'),
        placement: flags.get('--placement'),
        dryRun,
      }),
    ),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
