import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  discoverNextStaticAssets,
  publishNextStaticAssets,
  type PublishNextStaticAssetsOptions,
} from './next-static-assets';
import { STATIC_ASSET_CACHE_CONTROL } from './static-asset-upload';

type StoredAsset = { contents: Uint8Array; contentType?: string; cacheControl?: string; checksumSha256?: string };
const directories: string[] = [];
async function fixture(files: Record<string, string> = { 'chunks/abc.js': 'window.runtime = true;' }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'next-static-assets-'));
  directories.push(directory);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(directory, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents);
  }
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const sha256 = (contents: Uint8Array) => createHash('sha256').update(contents).digest('base64');
function preconditionFailed() {
  return Object.assign(new Error('PreconditionFailed'), { $metadata: { httpStatusCode: 412 } });
}

function storage() {
  const objects = new Map<string, StoredAsset>();
  const puts: PutObjectCommandInput[] = [];
  const calls: (PutObjectCommand | HeadObjectCommand | GetObjectCommand)[] = [];
  const send = vi.fn(
    async (
      command: PutObjectCommand | HeadObjectCommand | GetObjectCommand,
      options?: { abortSignal?: AbortSignal },
    ) => {
      calls.push(command);
      expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
      const key = command.input.Key!;
      if (command instanceof PutObjectCommand) {
        puts.push(command.input);
        if (objects.has(key)) throw preconditionFailed();
        expect(command.input.IfNoneMatch).toBe('*');
        const contents = Buffer.from(command.input.Body as Uint8Array);
        objects.set(key, {
          contents,
          contentType: command.input.ContentType,
          cacheControl: command.input.CacheControl,
          checksumSha256: command.input.ChecksumSHA256,
        });
        return { $metadata: {} };
      }
      const object = objects.get(key);
      if (!object) throw Object.assign(new Error('NotFound'), { $metadata: { httpStatusCode: 404 } });
      const metadata = {
        ContentLength: object.contents.byteLength,
        ContentType: object.contentType,
        CacheControl: object.cacheControl,
        ChecksumSHA256: object.checksumSha256,
        $metadata: {},
      };
      return command instanceof HeadObjectCommand
        ? metadata
        : { ...metadata, Body: { transformToWebStream: () => new Response(Uint8Array.from(object.contents)).body } };
    },
  );
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const key = new URL(input instanceof Request ? input.url : input).pathname
      .slice(1)
      .split('/')
      .map(decodeURIComponent)
      .join('/');
    const object = objects.get(key);
    if (!object) return new Response(null, { status: 404 });
    return new Response(Uint8Array.from(object.contents), {
      headers: {
        'content-type': object.contentType!,
        'content-length': String(object.contents.byteLength),
        'cache-control': object.cacheControl!,
        'access-control-allow-origin': '*',
        'cf-ray': 'cdn-test',
      },
    });
  });
  const options = (directory: string): PublishNextStaticAssetsOptions => ({
    directory,
    bucket: 'static-assets',
    client: { send } as unknown as S3Client,
    fetchImpl: fetchImpl as typeof fetch,
    beforeRequest: async () => {},
    sleep: async () => {},
  });
  return { objects, puts, calls, send, fetchImpl, options };
}

describe('Next runtime asset discovery', () => {
  it('keeps Next runtime paths and MIME types, excluding source maps', async () => {
    const directory = await fixture({
      'chunks/abc.js': 'javascript',
      'css/abc.css': 'css',
      'build/_buildManifest.js': 'manifest',
      'media/font.p.woff2': 'font',
      'media/image.webp': 'image',
      'build/data.json': '{}',
      'chunks/abc.js.map': 'private source',
    });
    const assets = await discoverNextStaticAssets(directory);
    expect(assets.map((asset) => [asset.objectKey, asset.contentType])).toEqual([
      ['_next/static/build/_buildManifest.js', 'application/javascript'],
      ['_next/static/build/data.json', 'application/json'],
      ['_next/static/chunks/abc.js', 'application/javascript'],
      ['_next/static/css/abc.css', 'text/css'],
      ['_next/static/media/font.p.woff2', 'font/woff2'],
      ['_next/static/media/image.webp', 'image/webp'],
    ]);
    expect(assets.every((asset) => asset.bytes > 0 && /^[a-f\d]{64}$/.test(asset.sha256))).toBe(true);
  });

  it('refuses empty/source-map-only directories and unsupported artifacts before publishing', async () => {
    const fileGroups: Record<string, string>[] = [
      {},
      { 'chunk.js.map': '{}' },
      { 'chunks/ok.js': 'ok', 'server.nft.txt': 'not runtime' },
    ];
    for (const files of fileGroups) {
      const remote = storage();
      await expect(publishNextStaticAssets(remote.options(await fixture(files)))).rejects.toThrow(
        /no runtime files|Unsupported runtime asset type/,
      );
      expect(remote.send).not.toHaveBeenCalled();
    }
  });

  it('refuses root, directory, file, and even source-map symlinks', async () => {
    const target = await fixture();
    for (const name of ['linked.js', 'linked.js.map', 'linked-directory']) {
      const directory = await fixture();
      await symlink(name === 'linked-directory' ? target : join(target, 'chunks/abc.js'), join(directory, name));
      await expect(discoverNextStaticAssets(directory)).rejects.toThrow('Symlinks are not allowed');
    }
    const parent = await fixture({});
    await symlink(target, join(parent, 'root'));
    await expect(discoverNextStaticAssets(join(parent, 'root'))).rejects.toThrow('Symlinks are not allowed');
  });

  it('refuses traversal, backslash paths, and non-directory roots', async () => {
    const directory = await fixture();
    await expect(discoverNextStaticAssets(`${directory}/../${directory.split('/').at(-1)}`)).rejects.toThrow(
      'traversal',
    );
    await expect(discoverNextStaticAssets(join(directory, 'chunks/abc.js'))).rejects.toThrow('not a directory');
    await writeFile(join(directory, 'escaped\\name.js'), 'unsafe');
    await expect(discoverNextStaticAssets(directory)).rejects.toThrow('Unsafe runtime asset path');
  });
});

describe('append-only Next runtime publication', () => {
  it('conditionally publishes every runtime file and verifies signed and public bytes plus both CORS request variants', async () => {
    const directory = await fixture({
      'chunks/abc.js': 'runtime',
      'css/abc.css': 'styles',
      'chunks/abc.js.map': 'source',
    });
    const remote = storage();
    const result = await publishNextStaticAssets(remote.options(directory));
    expect(result).toEqual({ assets: 2, uploaded: 2, existing: 0, bytes: 13 });
    expect(remote.puts).toHaveLength(2);
    for (const input of remote.puts) {
      expect(input).toMatchObject({
        Bucket: 'static-assets',
        IfNoneMatch: '*',
        CacheControl: STATIC_ASSET_CACHE_CONTROL,
      });
      expect(input.ChecksumSHA256).toBe(sha256(input.Body as Uint8Array));
    }
    expect(remote.calls.filter((command) => command instanceof HeadObjectCommand)).toHaveLength(2);
    expect(remote.calls.filter((command) => command instanceof GetObjectCommand)).toHaveLength(2);
    expect(remote.fetchImpl).toHaveBeenCalledTimes(4);
    const initOptions = remote.fetchImpl.mock.calls.map((call) => (call as unknown as [string, RequestInit])[1]);
    expect(initOptions.filter((options) => options.headers === undefined)).toHaveLength(2);
    expect(
      initOptions.filter((options) => new Headers(options.headers).get('origin') === 'https://www.boardsesh.com'),
    ).toHaveLength(2);
    expect(initOptions.every((options) => options.redirect === 'error' && options.signal instanceof AbortSignal)).toBe(
      true,
    );
  });

  it('preserves Next route segment names while escaping their public URLs', async () => {
    const directory = await fixture({ 'chunks/app/[slug]/page file.js': 'runtime', 'media/café#?.png': 'image' });
    const remote = storage();
    await expect(publishNextStaticAssets(remote.options(directory))).resolves.toMatchObject({ assets: 2, uploaded: 2 });
    expect(remote.objects.has('_next/static/chunks/app/[slug]/page file.js')).toBe(true);
    const urls = remote.fetchImpl.mock.calls.map(([input]) =>
      input instanceof Request ? input.url : input.toString(),
    );
    expect(urls.some((url) => url.includes('/chunks/app/%5Bslug%5D/page%20file.js'))).toBe(true);
    expect(urls.some((url) => url.includes('/media/caf%C3%A9%23%3F.png'))).toBe(true);
  });

  it('retains identical assets across builds without replacing or deleting older keys', async () => {
    const directory = await fixture();
    const remote = storage();
    remote.objects.set('_next/static/old-build/old.js', { contents: Buffer.from('old') });
    await publishNextStaticAssets(remote.options(directory));
    const original = remote.objects.get('_next/static/chunks/abc.js');
    original!.checksumSha256 = undefined; // Older R2 objects may lack S3 checksum metadata.
    await expect(publishNextStaticAssets(remote.options(directory))).resolves.toMatchObject({
      assets: 1,
      uploaded: 0,
      existing: 1,
    });
    expect(remote.objects.get('_next/static/chunks/abc.js')).toBe(original);
    expect(remote.objects.get('_next/static/old-build/old.js')?.contents.toString()).toBe('old');
    expect(
      remote.calls.every(
        (command) =>
          command instanceof PutObjectCommand ||
          command instanceof HeadObjectCommand ||
          command instanceof GetObjectCommand,
      ),
    ).toBe(true);
  });

  it('fails a same-length hash collision rather than replacing the existing object', async () => {
    const directory = await fixture({ 'chunks/abc.js': 'new' });
    const remote = storage();
    const old = {
      contents: Buffer.from('old'),
      contentType: 'application/javascript',
      cacheControl: STATIC_ASSET_CACHE_CONTROL,
    };
    remote.objects.set('_next/static/chunks/abc.js', old);
    await expect(publishNextStaticAssets(remote.options(directory))).rejects.toThrow('GET checksum mismatch');
    expect(remote.objects.get('_next/static/chunks/abc.js')).toBe(old);
    expect(remote.puts).toHaveLength(1);
    expect(remote.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['contentType', 'cacheControl', 'checksumSha256'] as const)(
    'rejects incompatible existing %s metadata',
    async (field) => {
      const directory = await fixture({ 'chunks/abc.js': 'same' });
      const remote = storage();
      remote.objects.set('_next/static/chunks/abc.js', {
        contents: Buffer.from('same'),
        contentType: 'application/javascript',
        cacheControl: STATIC_ASSET_CACHE_CONTROL,
        checksumSha256: sha256(Buffer.from('same')),
        [field]: 'wrong',
      });
      await expect(publishNextStaticAssets(remote.options(directory))).rejects.toThrow(/mismatch/);
      expect(remote.puts).toHaveLength(1);
    },
  );

  it('checks the actual downloaded bytes even if HEAD advertises the expected checksum', async () => {
    const directory = await fixture({ 'chunks/abc.js': 'new' });
    const remote = storage();
    remote.objects.set('_next/static/chunks/abc.js', {
      contents: Buffer.from('old'),
      contentType: 'application/javascript',
      cacheControl: STATIC_ASSET_CACHE_CONTROL,
      checksumSha256: sha256(Buffer.from('new')),
    });
    await expect(publishNextStaticAssets(remote.options(directory))).rejects.toThrow('GET checksum mismatch');
  });

  it('hashes decoded CDN bytes rather than comparing compressed Content-Length', async () => {
    const directory = await fixture();
    const remote = storage();
    const originalFetch = remote.fetchImpl.getMockImplementation()!;
    remote.fetchImpl.mockImplementation(async (input) => {
      const response = await originalFetch(input);
      response.headers.set('content-encoding', 'br');
      response.headers.set('content-length', '7');
      return response;
    });
    await expect(publishNextStaticAssets(remote.options(directory))).resolves.toMatchObject({ uploaded: 1 });
  });

  it.each(['access-control-allow-origin', 'cf-ray', 'cache-control', 'content-type'] as const)(
    'fails when the no-Origin CDN response lacks required %s',
    async (header) => {
      const directory = await fixture();
      const remote = storage();
      const originalFetch = remote.fetchImpl.getMockImplementation()!;
      remote.fetchImpl.mockImplementation(async (input) => {
        const response = await originalFetch(input);
        response.headers.delete(header);
        return response;
      });
      await expect(publishNextStaticAssets(remote.options(directory))).rejects.toThrow('Public CDN validation failed');
      expect(remote.fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects altered CDN bytes and bounds oversized bodies', async () => {
    for (const contents of ['bad', 'far too many bytes']) {
      const directory = await fixture({ 'chunks/abc.js': 'new' });
      const remote = storage();
      remote.fetchImpl.mockImplementation(
        async () =>
          new Response(contents, {
            headers: {
              'content-type': 'application/javascript',
              'content-encoding': 'gzip',
              'cache-control': STATIC_ASSET_CACHE_CONTROL,
              'access-control-allow-origin': '*',
              'cf-ray': 'test',
            },
          }),
      );
      await expect(publishNextStaticAssets({ ...remote.options(directory), attempts: 1 })).rejects.toThrow(
        /byte\/hash mismatch|exceeds the expected/,
      );
    }
  });

  it('retries transient conditional-write races and CDN misses within a fixed attempt budget', async () => {
    const directory = await fixture();
    const remote = storage();
    const originalSend = remote.send.getMockImplementation()!;
    const originalFetch = remote.fetchImpl.getMockImplementation()!;
    remote.send.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Race'), { $metadata: { httpStatusCode: 409 } });
    });
    remote.send.mockImplementation(originalSend);
    remote.fetchImpl.mockImplementationOnce(async () => new Response(null, { status: 404 }));
    remote.fetchImpl.mockImplementation(originalFetch);
    const sleep = vi.fn(async () => {});
    await expect(publishNextStaticAssets({ ...remote.options(directory), sleep })).resolves.toMatchObject({
      uploaded: 1,
    });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(remote.send).toHaveBeenCalledTimes(4);
    expect(remote.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('recovers an acknowledged-late conditional write without replacing its object', async () => {
    const directory = await fixture();
    const remote = storage();
    const originalSend = remote.send.getMockImplementation()!;
    remote.send.mockImplementationOnce(async (command, options) => {
      await originalSend(command, options);
      throw new Error('Connection lost after storage accepted the write');
    });
    const sleep = vi.fn(async () => {});
    await expect(publishNextStaticAssets({ ...remote.options(directory), sleep })).resolves.toMatchObject({
      assets: 1,
      uploaded: 0,
      existing: 1,
    });
    expect(remote.puts).toHaveLength(2);
    expect(remote.objects.size).toBe(1);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('stops storage and public retries at the configured budget', async () => {
    const directory = await fixture();
    const remote = storage();
    remote.send.mockRejectedValue(Object.assign(new Error('Unavailable'), { $metadata: { httpStatusCode: 503 } }));
    const sleep = vi.fn(async () => {});
    await expect(publishNextStaticAssets({ ...remote.options(directory), attempts: 3, sleep })).rejects.toThrow(
      'Unavailable',
    );
    expect(remote.send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    const unavailable = storage();
    unavailable.fetchImpl.mockImplementation(async () => new Response(null, { status: 503 }));
    await expect(publishNextStaticAssets({ ...unavailable.options(directory), attempts: 2 })).rejects.toThrow(
      'HTTP 503',
    );
    expect(unavailable.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('also validates CORS on requests carrying the website Origin', async () => {
    const directory = await fixture();
    const remote = storage();
    const originalFetch = remote.fetchImpl.getMockImplementation()!;
    const fetchImpl: typeof fetch = async (input, options) => {
      const response = await originalFetch(input);
      if (new Headers(options?.headers).has('origin')) response.headers.delete('access-control-allow-origin');
      return response;
    };
    await expect(publishNextStaticAssets({ ...remote.options(directory), fetchImpl })).rejects.toThrow(
      'Access-Control-Allow-Origin',
    );
    expect(remote.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    'private, max-age=31536000, immutable',
    'public, no-store, max-age=31536000, immutable',
    'public, s-maxage=31536000, max-age=0, immutable',
    'public, max-age=315360000, immutable',
    'public, max-age=31536000, max-age=0, immutable',
    'public, max-age=31536000, max-age=31536000, immutable',
    'public, max-age=31536000, s-maxage=0, immutable',
    'public, private=Set-Cookie, max-age=31536000, immutable',
  ])('rejects contradictory CDN cache policy: %s', async (cacheControl) => {
    const directory = await fixture();
    const remote = storage();
    const originalFetch = remote.fetchImpl.getMockImplementation()!;
    remote.fetchImpl.mockImplementation(async (input) => {
      const response = await originalFetch(input);
      response.headers.set('cache-control', cacheControl);
      return response;
    });
    await expect(publishNextStaticAssets(remote.options(directory))).rejects.toThrow(
      /not publicly cacheable|immutable one-year caching/,
    );
  });

  it('bounds signed GET body reads with the same per-attempt deadline', async () => {
    const directory = await fixture();
    const remote = storage();
    const originalSend = remote.send.getMockImplementation()!;
    const cancel = vi.fn();
    remote.send.mockImplementation(async (command, options) => {
      const response = await originalSend(command, options);
      return command instanceof GetObjectCommand
        ? { ...response, Body: { transformToWebStream: () => new ReadableStream({ cancel }) } }
        : response;
    });
    await expect(
      publishNextStaticAssets({ ...remote.options(directory), attempts: 2, requestTimeoutMs: 5 }),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(remote.fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed even when a dependency rejects without an Error instance', async () => {
    const directory = await fixture();
    const remote = storage();
    remote.send.mockRejectedValue(undefined);
    await expect(publishNextStaticAssets({ ...remote.options(directory), attempts: 1 })).rejects.toBeUndefined();
    expect(remote.fetchImpl).not.toHaveBeenCalled();
  });

  it('does not retry denied storage writes or non-retryable CDN responses', async () => {
    const directory = await fixture();
    const denied = storage();
    denied.send.mockRejectedValue(Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } }));
    await expect(publishNextStaticAssets(denied.options(directory))).rejects.toThrow('AccessDenied');
    expect(denied.send).toHaveBeenCalledTimes(1);
    const forbidden = storage();
    forbidden.fetchImpl.mockResolvedValue(new Response(null, { status: 403 }));
    await expect(publishNextStaticAssets(forbidden.options(directory))).rejects.toThrow('HTTP 403');
    expect(forbidden.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('aborts stalled decoded CDN bodies and exhausts only the configured attempts', async () => {
    const directory = await fixture();
    const remote = storage();
    const cancel = vi.fn();
    remote.fetchImpl.mockImplementation(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: {
            'content-type': 'application/javascript',
            'cache-control': STATIC_ASSET_CACHE_CONTROL,
            'access-control-allow-origin': '*',
            'cf-ray': 'test',
          },
        }),
    );
    await expect(
      publishNextStaticAssets({ ...remote.options(directory), attempts: 2, requestTimeoutMs: 5 }),
    ).rejects.toThrow('Public CDN validation failed');
    expect(remote.fetchImpl).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('limits simultaneous assets while still publishing every file', async () => {
    const directory = await fixture(
      Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`chunks/${index}.js`, String(index)])),
    );
    const remote = storage();
    const originalSend = remote.send.getMockImplementation()!;
    let active = 0;
    let maximum = 0;
    remote.send.mockImplementation(async (command, options) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
      try {
        return await originalSend(command, options);
      } finally {
        active--;
      }
    });
    await expect(publishNextStaticAssets({ ...remote.options(directory), concurrency: 2 })).resolves.toMatchObject({
      assets: 8,
      uploaded: 8,
    });
    expect(maximum).toBe(2);
  });
});
