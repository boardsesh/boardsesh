import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  assertEnvironment,
  assertPlatform,
  assertR2Bundle,
  assertRuntime,
  assertFrozenSource,
  checkExport,
  FROZEN_SOURCE,
  parseSignedManifest,
  RUNTIMES,
  SNAPSHOT_BASE,
  validateManifest,
  verifyDelivery,
  safeProofFailure,
} from './r2-frozen-reader';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const bundle = Buffer.concat([Buffer.from('c61fbc03c103191f', 'hex'), Buffer.from(SNAPSHOT_BASE)]);
const environment = {
  EXPO_PUBLIC_SNAPSHOT_BASE_URL: SNAPSHOT_BASE,
  EXPO_UPDATES_URL: 'https://updates.boardsesh.com/manifest',
};
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const certificate = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }));
function signed(payload: string, signaturePayload = payload): string {
  const signature = sign('RSA-SHA256', Buffer.from(signaturePayload), privateKey).toString('base64');
  return `--fixture\r\nContent-Disposition: form-data; name="manifest"\r\nexpo-signature: sig="${signature}", keyid="main", alg="rsa-v1_5-sha256"\r\n\r\n${payload}\r\n--fixture--\r\n`;
}
describe('frozen reader fails closed', () => {
  it('reports useful static failures without printing credential-bearing external errors', () => {
    expect(safeProofFailure(new Error('Manifest signature invalid'))).toBe('Manifest signature invalid');
    expect(safeProofFailure(new Error('fetch failed: https://example.test/?X-Amz-Signature=private-fixture'))).toBe(
      'Unexpected external proof failure',
    );
    expect(safeProofFailure(new SyntaxError('private-fixture response text'))).toBe(
      'Unexpected external proof failure',
    );
  });
  it('pins source HEAD, tracked cleanliness and original certificate independently', () => {
    const root = mkdtempSync(join(tmpdir(), 'r2-frozen-source-fixture-'));
    const certificatePath = join(root, 'packages/mobile/certs/certificate.pem');
    mkdirSync(join(root, 'packages/mobile/certs'), { recursive: true });
    copyFileSync(join(REPO_ROOT, 'packages/mobile/certs/certificate.pem'), certificatePath);
    const git = vi.mocked(execFileSync);
    try {
      git.mockReturnValueOnce(FROZEN_SOURCE).mockReturnValueOnce('');
      expect(assertFrozenSource(root).length).toBeGreaterThan(0);
      git.mockReturnValueOnce('0'.repeat(40));
      expect(() => assertFrozenSource(root)).toThrow('Frozen source changed');
      git.mockReturnValueOnce(FROZEN_SOURCE).mockReturnValueOnce(' M packages/mobile/app.config.ts');
      expect(() => assertFrozenSource(root)).toThrow('Frozen source changed');
      writeFileSync(certificatePath, 'different public certificate fixture');
      git.mockReturnValueOnce(FROZEN_SOURCE).mockReturnValueOnce('');
      expect(() => assertFrozenSource(root)).toThrow('certificate changed');
    } finally {
      git.mockReset();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('validates real export fixtures and rejects malformed or escaping asset paths', () => {
    const mobile = mkdtempSync(join(tmpdir(), 'r2-frozen-export-fixture-'));
    const output = join(mobile, 'dist');
    const bundlePath = '_expo/static/js/ios/entry-fixture.hbc';
    mkdirSync(join(output, '_expo/static/js/ios'), { recursive: true });
    writeFileSync(join(output, bundlePath), bundle);
    writeFileSync(
      join(output, bundlePath + '.map'),
      JSON.stringify({ version: 3, sources: [], mappings: '', debugId: '00000000-0000-4000-8000-000000000000' }),
    );
    writeFileSync(join(output, 'asset.bin'), 'public fixture asset');
    const metadata = (path: unknown) =>
      writeFileSync(
        join(output, 'metadata.json'),
        JSON.stringify({
          version: 0,
          bundler: 'metro',
          fileMetadata: { ios: { bundle: bundlePath, assets: [{ path, ext: 'bin' }] } },
        }),
      );
    try {
      metadata('asset.bin');
      expect(checkExport(output, 'ios').assetHashes).toEqual([
        createHash('sha256').update('public fixture asset').digest('base64url'),
      ]);
      for (const path of [
        '../asset.bin',
        '/asset.bin',
        'a//b',
        './asset.bin',
        'a/./b',
        'a/../b',
        'a\\b',
        '',
        null,
        'a\0b',
      ]) {
        metadata(path);
        expect(() => checkExport(output, 'ios')).toThrow();
      }
    } finally {
      rmSync(mobile, { recursive: true, force: true });
    }
  });
  it('accepts only one of the fixed platform/full-runtime pairs', () => {
    expect(assertPlatform('ios')).toBe('ios');
    expect(() => assertPlatform('all')).toThrow();
    assertRuntime('android', RUNTIMES.android);
    expect(() => assertRuntime('ios', RUNTIMES.android)).toThrow();
    expect(() => assertRuntime('ios', RUNTIMES.ios.slice(0, 12))).toThrow();
  });
  it('requires genuine compiled Hermes R2 content', () => {
    assertR2Bundle(bundle);
    expect(() => assertR2Bundle(Buffer.from(SNAPSHOT_BASE))).toThrow();
    expect(() => assertR2Bundle(bundle.subarray(0, 8))).toThrow();
    expect(() => assertR2Bundle(Buffer.concat([bundle, Buffer.from('storage.dev/board-snapshots/v1')]))).toThrow();
    for (const host of ['boardsesh-board-snapshots.t3.tigrisfiles.io', 't3.tigrisbucket.io']) {
      expect(() => assertR2Bundle(Buffer.concat([bundle, Buffer.from(host)]))).toThrow();
    }
  });
  it('rejects native overrides and mismatched platform env', () => {
    assertEnvironment(environment, 'ios');
    assertEnvironment({ ...environment, GOOGLE_MAPS_API_KEY: 'public-fixture' }, 'android');
    for (const key of ['EXPO_UPDATES_FINGERPRINT_OVERRIDE', 'EAS_BUILD', 'EAS_BUILD_PROFILE', 'BOARDSESH_WEB']) {
      expect(() => assertEnvironment({ ...environment, [key]: '1' }, 'ios')).toThrow();
    }
    expect(() => assertEnvironment(environment, 'android')).toThrow();
    expect(() => assertEnvironment({ ...environment, GOOGLE_MAPS_API_KEY: 'public-fixture' }, 'ios')).toThrow();
    expect(() =>
      assertEnvironment({ ...environment, EXPO_PUBLIC_SNAPSHOT_BASE_URL: 'https://wrong.example' }, 'ios'),
    ).toThrow();
  });
  it('verifies the exact manifest bytes and original signing recipient', () => {
    const payload = JSON.stringify({ runtimeVersion: RUNTIMES.ios });
    expect(parseSignedManifest('multipart/mixed; boundary=fixture', signed(payload), certificate)).toEqual(
      JSON.parse(payload),
    );
    expect(() =>
      parseSignedManifest('multipart/mixed; boundary=fixture', signed(payload, '{}'), certificate),
    ).toThrow();
    expect(() => parseSignedManifest('application/json', payload, certificate)).toThrow();
    expect(() =>
      parseSignedManifest('multipart/mixed; boundary=fixture', signed(payload) + signed(payload), certificate),
    ).toThrow();
    expect(() =>
      parseSignedManifest(
        'multipart/mixed; boundary=fixture',
        signed(payload).replace('keyid="main"', 'keyid="other"'),
        certificate,
      ),
    ).toThrow();
  });
  it('rejects existing update, wrong branch and absent asset list', () => {
    const manifest = {
      runtimeVersion: RUNTIMES.ios,
      id: '00000000-0000-4000-8000-000000000000',
      createdAt: new Date().toISOString(),
      extra: { branch: 'production' },
      assets: [],
    };
    validateManifest(manifest, 'ios', new Date(Date.now() - 10000).toISOString());
    expect(() => validateManifest(manifest, 'ios', manifest.createdAt)).toThrow();
    expect(() => validateManifest({ ...manifest, extra: { branch: 'pr-6008' } }, 'ios', '2026-01-01')).toThrow();
    expect(() => validateManifest({ ...manifest, assets: null }, 'ios', '2026-01-01')).toThrow();
    expect(() => validateManifest(manifest, 'ios', 'invalid')).toThrow();
  });
  it('streams signed delivery and rejects altered assets or foreign storage', async () => {
    const hash = createHash('sha256').update(bundle).digest('base64url');
    const url = 'https://7e9cab940b939f124941596d68fe0199.r2.cloudflarestorage.com/boardsesh-ota-v3/fixture';
    const manifest = {
      runtimeVersion: RUNTIMES.ios,
      id: '00000000-0000-4000-8000-000000000000',
      createdAt: new Date().toISOString(),
      extra: { branch: 'production' },
      assets: [],
      launchAsset: { url, hash },
    };
    let altered = false;
    const fakeFetch = vi.fn(async (request: string | URL | Request) =>
      String(request).includes('/manifest')
        ? new Response(signed(JSON.stringify(manifest)), {
            headers: { 'content-type': 'multipart/mixed; boundary=fixture' },
          })
        : new Response(altered ? Buffer.from('altered fixture') : bundle),
    );
    vi.stubGlobal('fetch', fakeFetch);
    try {
      const start = new Date(Date.now() - 10000).toISOString();
      const expectedSha = createHash('sha256').update(bundle).digest('hex');
      expect((await verifyDelivery('ios', start, certificate, expectedSha, [])).assets).toBe(1);
      altered = true;
      await expect(verifyDelivery('ios', start, certificate, expectedSha, [])).rejects.toThrow('hash mismatch');
      altered = false;
      manifest.launchAsset.url = 'https://foreign.example/boardsesh-ota-v3/fixture';
      await expect(verifyDelivery('ios', start, certificate, expectedSha, [])).rejects.toThrow('private R2 bucket');
      expect(fakeFetch).toHaveBeenCalledTimes(5);
      await expect(verifyDelivery('ios', start, certificate, expectedSha, [hash])).rejects.toThrow(
        'asset list differs',
      );
      Reflect.deleteProperty(manifest, 'launchAsset');
      await expect(verifyDelivery('ios', start, certificate, expectedSha, [])).rejects.toThrow('Expected object');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('permits one known proxy redirect and rejects foreign redirect targets', async () => {
    const hash = createHash('sha256').update(bundle).digest('base64url');
    const manifest = {
      runtimeVersion: RUNTIMES.ios,
      id: '00000000-0000-4000-8000-000000000000',
      createdAt: new Date().toISOString(),
      extra: { branch: 'production' },
      assets: [],
      launchAsset: { url: 'https://updates.boardsesh.com/assets?ext=hbc&h=public-fixture&platform=ios', hash },
    };
    let target = 'https://boardsesh-ota-v3.7e9cab940b939f124941596d68fe0199.r2.cloudflarestorage.com/public-fixture';
    let secondRedirect = false;
    const fakeFetch = vi.fn(async (request: string | URL | Request, options?: RequestInit) => {
      const url = String(request);
      if (url.includes('/manifest'))
        return new Response(signed(JSON.stringify(manifest)), {
          headers: { 'content-type': 'multipart/mixed; boundary=fixture' },
        });
      if (new URL(url).pathname === '/assets') {
        expect(options?.redirect).toBe('manual');
        expect(options?.headers).toEqual({
          'user-agent': 'Boardsesh-R2-Migration-Acceptance/1',
          'expo-app-id': '007e6fd7-f200-448c-9449-8d48ba5d51fc',
        });
        return new Response(null, { status: 302, headers: { location: target } });
      }
      expect(options?.redirect).toBe('error');
      expect(options?.headers).toBeUndefined();
      return secondRedirect
        ? new Response(null, { status: 302, headers: { location: 'https://foreign.example' } })
        : new Response(bundle);
    });
    vi.stubGlobal('fetch', fakeFetch);
    try {
      const start = new Date(Date.now() - 10000).toISOString();
      const expectedSha = createHash('sha256').update(bundle).digest('hex');
      await verifyDelivery('ios', start, certificate, expectedSha, []);
      secondRedirect = true;
      await expect(verifyDelivery('ios', start, certificate, expectedSha, [])).rejects.toThrow(
        'Public delivery failed',
      );
      secondRedirect = false;
      target = 'https://foreign.example/private-fixture';
      await expect(verifyDelivery('ios', start, certificate, expectedSha, [])).rejects.toThrow('redirect target');
      expect(fakeFetch).toHaveBeenCalledTimes(8);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('keeps production credentials out of dry-run and pre-export steps', () => {
    const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/r2-frozen-reader-publication.yml'), 'utf8');
    expect(workflow).not.toMatch(/\n  (push|schedule|workflow_call):/);
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain('environment: Production');
    expect(workflow).toContain('default: true');
    expect(workflow).toContain('queue: max');
    const publishIndex = workflow.indexOf('      - name: Publish the validated shipped reader');
    expect(workflow.slice(0, publishIndex)).not.toContain('secrets.EOO_TOKEN');
    expect(workflow.match(/secrets.EOO_TOKEN/g)).toHaveLength(1);
    expect(workflow.match(/secrets.SENTRY_AUTH_TOKEN/g)).toHaveLength(1);
    expect(workflow).toContain('--clear --dump-sourcemap');
    expect(workflow).toContain('public_keys=(EXPO_PUBLIC_BACKEND_URL');
    expect(workflow).not.toContain('env |');
    expect(workflow).toContain('ref: 6986ca9100c0492586f42f1a88ce3d49b4986f07');
  });
});
