import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureProductionBaseline,
  parseCaptureArgs,
  parseStageReceipt,
  promoteArchivedOta,
  validateExport,
} from './mobile-ota-promote';

const APP_ID = '007e6fd7-f200-448c-9449-8d48ba5d51fc';
const COMMIT = 'a'.repeat(40);
const EXPORT_ASSET_HASH = '0a328cd9c1afd0afe8e3b1ec5165b1b4';
const RUNTIME = 'b'.repeat(40);
// Real xprem IDs are content hashes in UUID shape, not RFC 4122 UUIDs: no
// version or variant digits. The iOS one was served by production on 2026-09-26.
const BASELINE_IDS = {
  ios: 'a96bbffc-e084-91c9-61ee-0107f5b6857b',
  android: '22222222-2222-9222-6222-222222222222',
};

const requestUrl = (input: RequestInfo | URL): URL =>
  new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function stageFixture() {
  const root = mkdtempSync(join(tmpdir(), 'boardsesh-ota-promote-'));
  temporaryDirectories.push(root);
  const hashes: Record<'ios' | 'android', string> = { ios: '', android: '' };
  for (const platform of ['ios', 'android'] as const) {
    const directory = join(root, platform);
    mkdirSync(join(directory, '_expo', 'static', 'js', platform), { recursive: true });
    mkdirSync(join(directory, 'assets'), { recursive: true });
    const bundle = `_expo/static/js/${platform}/main.hbc`;
    const bytes = Buffer.from(`${platform}: original staged bundle`);
    writeFileSync(join(directory, bundle), bytes);
    // Real `expo export` shape: content-hash file name, type only in `ext`.
    writeFileSync(join(directory, 'assets', EXPORT_ASSET_HASH), Buffer.from([1, 2, 3]));
    writeFileSync(
      join(directory, 'metadata.json'),
      JSON.stringify({
        version: 0,
        bundler: 'metro',
        fileMetadata: { [platform]: { bundle, assets: [{ path: `assets/${EXPORT_ASSET_HASH}`, ext: 'png' }] } },
      }),
    );
    writeFileSync(
      join(directory, 'expoConfig.json'),
      JSON.stringify({
        updates: { requestHeaders: { 'expo-app-id': APP_ID, 'expo-channel-name': 'production' } },
      }),
    );
    hashes[platform] = createHash('sha256').update(bytes).digest('hex');
  }
  const receiptPath = join(root, 'receipt.json');
  writeFileSync(
    receiptPath,
    JSON.stringify({
      commitHash: COMMIT,
      message: 'Test staged release',
      platforms: {
        ios: { runtimeVersion: RUNTIME, bundleSha256: hashes.ios },
        android: { runtimeVersion: RUNTIME, bundleSha256: hashes.android },
      },
      baselineProductionUpdateIds: BASELINE_IDS,
    }),
  );
  return { root, receiptPath, hashes, iosExport: join(root, 'ios'), androidExport: join(root, 'android') };
}

function fetchServer(
  fixture: ReturnType<typeof stageFixture>,
  statusByPlatform: Partial<Record<'ios' | 'android', number>> = {},
) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = requestUrl(input);
    calls.push({ url, init });
    if (url.pathname.includes('/requestUploadUrl/production')) {
      const platform = url.searchParams.get('platform') as 'ios' | 'android';
      const filePath = `_expo/static/js/${platform}/main.hbc`;
      return Response.json({
        updateId: platform === 'ios' ? 101 : 102,
        // Only one file needs a PUT: xprem reuses the remaining requested assets.
        uploadRequests: [
          {
            requestUploadUrl: `https://bucket.example/${platform}/bundle`,
            fileName: 'main.hbc',
            filePath,
            headers: { 'x-amz-meta-source': 'staged' },
          },
        ],
      });
    }
    if (url.pathname.includes('/markUpdateAsUploaded/production')) {
      const platform = url.searchParams.get('platform') as 'ios' | 'android';
      return new Response('', { status: statusByPlatform[platform] ?? 200 });
    }
    if (url.pathname === '/manifest') {
      const headers = new Headers(init.headers);
      const platform = headers.get('expo-platform') as 'ios' | 'android';
      const bundleHash = Buffer.from(fixture.hashes[platform], 'hex').toString('base64url');
      const assetHash = createHash('sha256')
        .update(Buffer.from([1, 2, 3]))
        .digest('base64url');
      const expoClient = JSON.parse(readFileSync(join(fixture.root, platform, 'expoConfig.json'), 'utf8')) as unknown;
      return Response.json({
        id: BASELINE_IDS[platform],
        runtimeVersion: RUNTIME,
        launchAsset: { hash: bundleHash },
        assets: [{ hash: assetHash }],
        extra: { branch: 'production', expoClient },
      });
    }
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('stage receipt and export validation', () => {
  it('requires both platforms and valid fingerprints', () => {
    expect(() => parseStageReceipt({ commitHash: COMMIT, message: '', platforms: {} })).toThrow('Stage ios');
  });

  it('requires explicit baseline IDs and validates capture arguments', () => {
    const fixture = stageFixture();
    const raw = JSON.parse(readFileSync(fixture.receiptPath, 'utf8')) as Record<string, unknown>;
    delete raw.baselineProductionUpdateIds;
    expect(() => parseStageReceipt(raw)).toThrow('baselineProductionUpdateIds');
    expect(
      parseCaptureArgs([
        '--capture-baseline',
        '--app-id',
        APP_ID,
        '--ios-runtime',
        RUNTIME,
        '--android-runtime',
        RUNTIME,
        '--out',
        'ota-stage/baseline.json',
      ]),
    ).toMatchObject({ appId: APP_ID, out: 'ota-stage/baseline.json' });
  });

  it('rejects a bundle whose bytes differ from the receipt', () => {
    const fixture = stageFixture();
    writeFileSync(join(fixture.iosExport, '_expo/static/js/ios/main.hbc'), 'modified after staging');
    expect(() => validateExport(fixture.iosExport, 'ios', fixture.hashes.ios)).toThrow('differs from stage receipt');
  });

  it('accepts extensionless hashed assets and rejects a mismatched extension', () => {
    const fixture = stageFixture();
    expect(() => validateExport(fixture.iosExport, 'ios', fixture.hashes.ios)).not.toThrow();
    for (const asset of [
      { path: 'assets/icon.jpg', ext: 'png' },
      { path: 'assets/not-a-hash', ext: 'png' },
      { path: `assets/${EXPORT_ASSET_HASH}`, ext: '../png' },
    ]) {
      writeFileSync(join(fixture.iosExport, asset.path), Buffer.from([1]));
      writeFileSync(
        join(fixture.iosExport, 'metadata.json'),
        JSON.stringify({
          version: 0,
          bundler: 'metro',
          fileMetadata: { ios: { bundle: '_expo/static/js/ios/main.hbc', assets: [asset] } },
        }),
      );
      expect(() => validateExport(fixture.iosExport, 'ios', fixture.hashes.ios)).toThrow('asset extension mismatch');
    }
  });

  it('rejects a symbolic link inside the export', () => {
    const fixture = stageFixture();
    const original = join(fixture.iosExport, '_expo/static/js/ios/main.hbc');
    const moved = join(fixture.iosExport, '_expo/static/js/ios/actual.hbc');
    writeFileSync(moved, readFileSync(original));
    rmSync(original);
    symlinkSync(moved, original);
    expect(() => validateExport(fixture.iosExport, 'ios', fixture.hashes.ios)).toThrow('symbolic link');
  });

  it('rejects metadata paths that escape the export', () => {
    const fixture = stageFixture();
    writeFileSync(
      join(fixture.iosExport, 'metadata.json'),
      JSON.stringify({
        version: 0,
        bundler: 'metro',
        fileMetadata: { ios: { bundle: '../outside.hbc', assets: [] } },
      }),
    );
    expect(() => validateExport(fixture.iosExport, 'ios', fixture.hashes.ios)).toThrow('not normalized');
  });
});

describe('exact-byte production promotion', () => {
  it('captures an explicit null only for a no-update directive', async () => {
    const fixture = stageFixture();
    const server = fetchServer(fixture);
    const noUpdateFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (requestUrl(input).pathname === '/manifest' && new Headers(init.headers).get('expo-platform') === 'ios') {
        return new Response(
          '--boundary\r\nexpo-part-type: directive\r\ncontent-type: application/json\r\n\r\n' +
            '{"type":"noUpdateAvailable"}\r\n--boundary--\r\n',
          { headers: { 'Content-Type': 'multipart/mixed; boundary=boundary' } },
        );
      }
      return server.fetchImpl(input, init);
    }) as unknown as typeof fetch;
    await expect(
      captureProductionBaseline({
        manifestUrl: 'https://updates.example/manifest',
        appId: APP_ID,
        runtimeVersions: { ios: RUNTIME, android: RUNTIME },
        fetchImpl: noUpdateFetch,
      }),
    ).resolves.toEqual({ ios: null, android: BASELINE_IDS.android });
  });

  it('fails closed on rollback or malformed baseline responses', async () => {
    const fixture = stageFixture();
    for (const body of ['{"type":"rollBackToEmbedded"}', '{"unknown":true}']) {
      const server = fetchServer(fixture);
      const badFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        if (requestUrl(input).pathname === '/manifest' && new Headers(init.headers).get('expo-platform') === 'ios') {
          return new Response(body, { headers: { 'Content-Type': 'application/json' } });
        }
        return server.fetchImpl(input, init);
      }) as unknown as typeof fetch;
      await expect(
        captureProductionBaseline({
          manifestUrl: 'https://updates.example/manifest',
          appId: APP_ID,
          runtimeVersions: { ios: RUNTIME, android: RUNTIME },
          fetchImpl: badFetch,
        }),
      ).rejects.toThrow();
    }
  });

  it('rejects a newer production update before requesting upload leases', async () => {
    const fixture = stageFixture();
    const server = fetchServer(fixture);
    const changedFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (requestUrl(input).pathname === '/manifest' && new Headers(init.headers).get('expo-platform') === 'ios') {
        const response = await server.fetchImpl(input, init);
        const body = JSON.parse(await response.text()) as Record<string, unknown>;
        body.id = '33333333-3333-4333-8333-333333333333';
        return Response.json(body);
      }
      return server.fetchImpl(input, init);
    }) as unknown as typeof fetch;
    await expect(
      promoteArchivedOta({
        receiptPath: fixture.receiptPath,
        iosExport: fixture.iosExport,
        androidExport: fixture.androidExport,
        manifestUrl: 'https://updates.example/manifest',
        token: 'test-token',
        fetchImpl: changedFetch,
      }),
    ).rejects.toThrow('changed since staging began');
    expect(server.calls.some((call) => call.url.pathname.includes('/requestUploadUrl/production'))).toBe(false);
  });

  it('allows a new runtime with no production update until this promotion finalizes', async () => {
    const fixture = stageFixture();
    const receipt = JSON.parse(readFileSync(fixture.receiptPath, 'utf8')) as {
      baselineProductionUpdateIds: { ios: string | null; android: string | null };
    };
    receipt.baselineProductionUpdateIds.ios = null;
    writeFileSync(fixture.receiptPath, JSON.stringify(receipt));
    const server = fetchServer(fixture);
    let iosFinalized = false;
    const noUpdateFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = requestUrl(input);
      const platform = new Headers(init.headers).get('expo-platform');
      if (url.pathname === '/manifest' && platform === 'ios' && !iosFinalized) {
        return Response.json({ type: 'noUpdateAvailable' });
      }
      const response = await server.fetchImpl(input, init);
      if (url.pathname.includes('/markUpdateAsUploaded/production') && url.searchParams.get('platform') === 'ios') {
        iosFinalized = true;
      }
      return response;
    }) as unknown as typeof fetch;
    await promoteArchivedOta({
      receiptPath: fixture.receiptPath,
      iosExport: fixture.iosExport,
      androidExport: fixture.androidExport,
      manifestUrl: 'https://updates.example/manifest',
      token: 'test-token',
      fetchImpl: noUpdateFetch,
    });
  });

  it('blocks a new runtime when production gains an update after staging', async () => {
    const fixture = stageFixture();
    const receipt = JSON.parse(readFileSync(fixture.receiptPath, 'utf8')) as {
      baselineProductionUpdateIds: { ios: string | null; android: string | null };
    };
    receipt.baselineProductionUpdateIds.ios = null;
    writeFileSync(fixture.receiptPath, JSON.stringify(receipt));
    const server = fetchServer(fixture);
    await expect(
      promoteArchivedOta({
        receiptPath: fixture.receiptPath,
        iosExport: fixture.iosExport,
        androidExport: fixture.androidExport,
        manifestUrl: 'https://updates.example/manifest',
        token: 'test-token',
        fetchImpl: server.fetchImpl,
      }),
    ).rejects.toThrow('changed since staging began');
    expect(server.calls.some((call) => call.url.pathname.includes('/requestUploadUrl/production'))).toBe(false);
  });

  it('checks the baseline again immediately before each platform upload', async () => {
    const fixture = stageFixture();
    const server = fetchServer(fixture);
    let iosProbeCount = 0;
    const changedFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (requestUrl(input).pathname === '/manifest' && new Headers(init.headers).get('expo-platform') === 'ios') {
        iosProbeCount++;
        const response = await server.fetchImpl(input, init);
        if (iosProbeCount === 2) {
          const body = JSON.parse(await response.text()) as Record<string, unknown>;
          body.id = '33333333-3333-4333-8333-333333333333';
          return Response.json(body);
        }
        return response;
      }
      return server.fetchImpl(input, init);
    }) as unknown as typeof fetch;
    await expect(
      promoteArchivedOta({
        receiptPath: fixture.receiptPath,
        iosExport: fixture.iosExport,
        androidExport: fixture.androidExport,
        manifestUrl: 'https://updates.example/manifest',
        token: 'test-token',
        fetchImpl: changedFetch,
      }),
    ).rejects.toThrow('changed since staging began');
    expect(server.calls.some((call) => call.init.method === 'PUT')).toBe(false);
  });

  it('uploads archived bundle bytes to production without invoking an exporter', async () => {
    const fixture = stageFixture();
    const server = fetchServer(fixture);
    await promoteArchivedOta({
      receiptPath: fixture.receiptPath,
      iosExport: fixture.iosExport,
      androidExport: fixture.androidExport,
      manifestUrl: 'https://updates.example/manifest',
      token: 'test-token',
      fetchImpl: server.fetchImpl,
    });
    const requests = server.calls.filter((call) => call.url.pathname.includes('/requestUploadUrl/production'));
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const body = JSON.parse(request.init.body as string) as { fileNames: string[]; message: string };
      expect(body.fileNames).toEqual(
        expect.arrayContaining(['metadata.json', 'expoConfig.json', `assets/${EXPORT_ASSET_HASH}`]),
      );
      expect(body.message).toBe('Test staged release');
      expect(request.url.searchParams.get('commitHash')).toBe(COMMIT);
      expect(request.url.searchParams.get('runtimeVersion')).toBe(RUNTIME);
    }
    expect(requests[0].url.searchParams.get('publishGroup')).toBe(requests[1].url.searchParams.get('publishGroup'));
    const puts = server.calls.filter((call) => call.init.method === 'PUT');
    expect(puts).toHaveLength(2);
    for (const platform of ['ios', 'android'] as const) {
      const upload = puts.find((call) => call.url.pathname.includes(platform));
      expect(Buffer.from(upload?.init.body as Buffer)).toEqual(
        readFileSync(join(fixture.root, platform, `_expo/static/js/${platform}/main.hbc`)),
      );
      expect(upload?.init.redirect).toBe('error');
      expect(upload?.init.headers).toMatchObject({ 'x-amz-meta-source': 'staged' });
    }
    expect(server.calls.filter((call) => call.url.pathname.includes('/markUpdateAsUploaded/production'))).toHaveLength(
      2,
    );
  });

  it('uploads hash-named assets with the MIME type in Expo metadata', async () => {
    const fixture = stageFixture();
    const server = fetchServer(fixture);
    const assetPath = `assets/${EXPORT_ASSET_HASH}`;
    const assetFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = requestUrl(input);
      if (url.pathname.includes('/requestUploadUrl/production')) {
        return Response.json({
          updateId: url.searchParams.get('platform') === 'ios' ? 101 : 102,
          uploadRequests: [
            {
              requestUploadUrl: `https://bucket.example/${url.searchParams.get('platform')}/asset`,
              fileName: EXPORT_ASSET_HASH,
              filePath: assetPath,
            },
          ],
        });
      }
      return server.fetchImpl(input, init);
    }) as unknown as typeof fetch;
    await promoteArchivedOta({
      receiptPath: fixture.receiptPath,
      iosExport: fixture.iosExport,
      androidExport: fixture.androidExport,
      manifestUrl: 'https://updates.example/manifest',
      token: 'test-token',
      fetchImpl: assetFetch,
    });
    const uploads = server.calls.filter((call) => call.init.method === 'PUT');
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(upload.init.headers).toMatchObject({ 'Content-Type': 'image/png' });
      expect(Buffer.from(upload.init.body as Buffer)).toEqual(Buffer.from([1, 2, 3]));
    }
  });

  it('rejects a server request for an undeclared file before any upload', async () => {
    const fixture = stageFixture();
    const server = fetchServer(fixture);
    const maliciousFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = requestUrl(input);
      if (url.pathname.includes('/requestUploadUrl/production') && url.searchParams.get('platform') === 'android') {
        return Response.json({
          updateId: 102,
          uploadRequests: [
            {
              requestUploadUrl: 'https://bucket.example/evil',
              fileName: 'secret',
              filePath: '../secret',
            },
          ],
        });
      }
      return server.fetchImpl(input, init);
    }) as unknown as typeof fetch;
    await expect(
      promoteArchivedOta({
        receiptPath: fixture.receiptPath,
        iosExport: fixture.iosExport,
        androidExport: fixture.androidExport,
        manifestUrl: 'https://updates.example/manifest',
        token: 'test-token',
        fetchImpl: maliciousFetch,
      }),
    ).rejects.toThrow('not an exported file');
    expect(server.calls.some((call) => call.init.method === 'PUT')).toBe(false);
  });

  it('rejects duplicate server upload paths before any PUT', async () => {
    const fixture = stageFixture();
    const server = fetchServer(fixture);
    const duplicateFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = requestUrl(input);
      if (url.pathname.includes('/requestUploadUrl/production') && url.searchParams.get('platform') === 'android') {
        const filePath = '_expo/static/js/android/main.hbc';
        const item = { requestUploadUrl: 'https://bucket.example/android/bundle', fileName: 'main.hbc', filePath };
        return Response.json({ updateId: 102, uploadRequests: [item, item] });
      }
      return server.fetchImpl(input, init);
    }) as unknown as typeof fetch;
    await expect(
      promoteArchivedOta({
        receiptPath: fixture.receiptPath,
        iosExport: fixture.iosExport,
        androidExport: fixture.androidExport,
        manifestUrl: 'https://updates.example/manifest',
        token: 'test-token',
        fetchImpl: duplicateFetch,
      }),
    ).rejects.toThrow('Duplicate upload request');
    expect(server.calls.some((call) => call.init.method === 'PUT')).toBe(false);
  });

  it('retries transient request, PUT, and finalize failures', async () => {
    const fixture = stageFixture();
    const server = fetchServer(fixture);
    const failures = { request: 0, upload: 0, finalize: 0 };
    const retryingFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = requestUrl(input);
      if (
        url.pathname.includes('/requestUploadUrl/production') &&
        url.searchParams.get('platform') === 'ios' &&
        failures.request++ === 0
      ) {
        return new Response('throttled', { status: 429, headers: { 'Retry-After': '0.001' } });
      }
      if (url.hostname === 'bucket.example' && url.pathname.includes('/ios/') && failures.upload++ === 0) {
        return new Response('slow down', { status: 503, headers: { 'Retry-After': '0.001' } });
      }
      if (
        url.pathname.includes('/markUpdateAsUploaded/production') &&
        url.searchParams.get('platform') === 'ios' &&
        failures.finalize++ === 0
      ) {
        return new Response('gateway', { status: 503, headers: { 'Retry-After': '0.001' } });
      }
      return server.fetchImpl(input, init);
    }) as unknown as typeof fetch;
    await promoteArchivedOta({
      receiptPath: fixture.receiptPath,
      iosExport: fixture.iosExport,
      androidExport: fixture.androidExport,
      manifestUrl: 'https://updates.example/manifest',
      token: 'test-token',
      fetchImpl: retryingFetch,
    });
    expect(failures).toEqual({ request: 2, upload: 2, finalize: 2 });
  });

  it('accepts a duplicate only when production serves the exact archived bundle', async () => {
    const fixture = stageFixture();
    const server = fetchServer(fixture, { ios: 406 });
    await promoteArchivedOta({
      receiptPath: fixture.receiptPath,
      iosExport: fixture.iosExport,
      androidExport: fixture.androidExport,
      manifestUrl: 'https://updates.example/manifest',
      token: 'test-token',
      fetchImpl: server.fetchImpl,
    });
    expect(server.calls.filter((call) => call.url.pathname === '/manifest')).toHaveLength(6);
  });

  it('verifies the signed multipart manifest served in production', async () => {
    const fixture = stageFixture();
    const server = fetchServer(fixture);
    const multipartFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const response = await server.fetchImpl(input, init);
      if (requestUrl(input).pathname !== '/manifest') return response;
      const manifestJson = await response.text();
      const boundary = 'xprem-test-boundary';
      return new Response(
        `--${boundary}\r\nexpo-part-type: manifest\r\ncontent-type: application/json\r\n\r\n${manifestJson}\r\n` +
          `--${boundary}\r\nexpo-part-type: signature\r\n\r\nsignature\r\n--${boundary}--\r\n`,
        { headers: { 'Content-Type': `multipart/mixed; boundary=${boundary}` } },
      );
    }) as unknown as typeof fetch;
    await promoteArchivedOta({
      receiptPath: fixture.receiptPath,
      iosExport: fixture.iosExport,
      androidExport: fixture.androidExport,
      manifestUrl: 'https://updates.example/manifest',
      token: 'test-token',
      fetchImpl: multipartFetch,
    });
  });

  it('rejects a duplicate whose production manifest serves different bytes', async () => {
    const fixture = stageFixture();
    const server = fetchServer(fixture, { ios: 406 });
    const wrongManifestFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = requestUrl(input);
      if (url.pathname === '/manifest' && new Headers(init.headers).get('expo-platform') === 'ios') {
        const expoClient = JSON.parse(readFileSync(join(fixture.iosExport, 'expoConfig.json'), 'utf8')) as unknown;
        return Response.json({
          id: BASELINE_IDS.ios,
          runtimeVersion: RUNTIME,
          launchAsset: { hash: 'different' },
          assets: [],
          extra: { branch: 'production', expoClient },
        });
      }
      return server.fetchImpl(input, init);
    }) as unknown as typeof fetch;
    await expect(
      promoteArchivedOta({
        receiptPath: fixture.receiptPath,
        iosExport: fixture.iosExport,
        androidExport: fixture.androidExport,
        manifestUrl: 'https://updates.example/manifest',
        token: 'test-token',
        fetchImpl: wrongManifestFetch,
        verificationDelaysMs: [],
      }),
    ).rejects.toThrow('production bundle hash differs');
  });

  it('fails closed when production has an active rollout', async () => {
    const fixture = stageFixture();
    const server = fetchServer(fixture, { ios: 409 });
    await expect(
      promoteArchivedOta({
        receiptPath: fixture.receiptPath,
        iosExport: fixture.iosExport,
        androidExport: fixture.androidExport,
        manifestUrl: 'https://updates.example/manifest',
        token: 'test-token',
        fetchImpl: server.fetchImpl,
      }),
    ).rejects.toThrow('active rollout');
    expect(
      server.calls.some((call) => call.url.searchParams.get('platform') === 'android' && call.init.method === 'PUT'),
    ).toBe(false);
  });
});
