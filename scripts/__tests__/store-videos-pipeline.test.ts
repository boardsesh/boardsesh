import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { appleList, appleToken, editableVersion, parseVideoSource, sourceStillOnTrain } from '../store-videos-gate';
import { mergeVideoManifest, videoReviewBody } from '../store-videos-publish';
import { parseCreativeManifest, type CreativeManifest } from '../store-creatives-r2';

function renderedManifest(): CreativeManifest {
  const manifest = parseCreativeManifest(JSON.parse(readFileSync('app-stores/apple/creative-assets.json', 'utf8')));
  for (const [variant, configuration] of Object.entries(manifest.variants)) {
    configuration.assets = Object.keys(manifest.locales).map((locale) => ({
      locale,
      placement: 'search-results',
      specId: 'real-apple-spec',
      placementGroup: 'real-apple-group',
      file: `.boardsesh/app-store-creatives/${variant}/${locale}/search-results.mp4`,
      sha256: 'a'.repeat(64),
      provenance: `.boardsesh/app-store-creatives/${variant}/${locale}/search-results.manifest.json`,
      provenanceSha256: 'b'.repeat(64),
      poster: `.boardsesh/app-store-creatives/${variant}/${locale}/search-results-poster.jpg`,
      posterSha256: 'c'.repeat(64),
    }));
  }
  return manifest;
}

describe('store video train gate', () => {
  it('keeps the pinned source through ordinary syncs while rejecting another train or rewritten history', () => {
    expect(sourceStillOnTrain('2.6.0', '2.6.0', 'ahead')).toBe(true);
    expect(sourceStillOnTrain('2.6.0', '2.6.0', 'identical')).toBe(true);
    expect(sourceStillOnTrain('2.6.0', '2.7.0', 'ahead')).toBe(false);
    expect(sourceStillOnTrain('2.6.0', '2.6.0', 'diverged')).toBe(false);
    expect(sourceStillOnTrain('2.6.0', '2.6.0', 'behind')).toBe(false);
  });
  it('requires an uploaded iOS build from a pinned release/next source', () => {
    const source = { sourceSha: 'a'.repeat(40), sourceBranch: 'release/next', version: '2.6.0', iosBuild: '123' };
    expect(parseVideoSource(source)).toEqual(source);
    for (const changed of [{ sourceBranch: 'main' }, { sourceSha: 'HEAD' }, { iosBuild: '' }, { version: 'next' }]) {
      expect(() => parseVideoSource({ ...source, ...changed })).toThrow();
    }
  });
  it('admits only the exact marketing version in an editable iOS state', () => {
    const version = (versionString: string, appStoreState: string) => ({
      id: versionString,
      attributes: { versionString, appStoreState },
    });
    const versions = [version('2.6.0', 'WAITING_FOR_REVIEW'), version('2.5.0', 'PREPARE_FOR_SUBMISSION')];
    expect(editableVersion(versions, '2.6.0')).toBeUndefined();
    versions.push(version('2.6.0', 'PREPARE_FOR_SUBMISSION'));
    expect(editableVersion(versions, '2.6.0')?.id).toBe('2.6.0');
    expect(() => editableVersion([...versions, version('2.6.0', 'REJECTED')], '2.6.0')).toThrow('Multiple');
  });
  it('prefers the modern Apple version state and falls back to the legacy field', () => {
    const modern = { id: 'draft', attributes: { versionString: '2.6.0', appVersionState: 'PREPARE_FOR_SUBMISSION' } };
    expect(editableVersion([modern], '2.6.0')).toEqual(modern);
    const legacy = { id: 'legacy', attributes: { versionString: '2.6.0', appStoreState: 'REJECTED' } };
    expect(editableVersion([legacy], '2.6.0')).toEqual(legacy);
    expect(
      editableVersion(
        [
          {
            ...modern,
            attributes: {
              ...modern.attributes,
              appVersionState: 'WAITING_FOR_REVIEW',
              appStoreState: 'PREPARE_FOR_SUBMISSION',
            },
          },
        ],
        '2.6.0',
      ),
    ).toBeUndefined();
    expect(editableVersion([{ id: 'missing', attributes: { versionString: '2.6.0' } }], '2.6.0')).toBeUndefined();
  });
  it('signs Apple JWTs with the required audience and ES256 JOSE signature', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const token = appleToken(
      {
        APP_STORE_CONNECT_API_KEY_ID: 'key',
        APP_STORE_CONNECT_ISSUER_ID: 'issuer',
        APP_STORE_CONNECT_API_KEY_BASE64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString(
          'base64',
        ),
      },
      1000,
    );
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
      iss: 'issuer',
      iat: 1000,
      exp: 1600,
      aud: 'appstoreconnect-v1',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });
  it('never sends Apple authorization to a foreign pagination origin', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: [], links: { next: 'https://other.example/secrets' } })));
    await expect(appleList('/v1/apps', 'secret', request)).rejects.toThrow('origin');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('video review manifest', () => {
  it('keeps the latest main header entries and requires all 20 videos with posters', () => {
    const current = renderedManifest();
    const header = {
      ...current.variants.default.assets[0],
      placement: 'header' as const,
      file: '.boardsesh/app-store-creatives/default/en-US/header.png',
    };
    current.variants.default.assets = [header];
    const rendered = renderedManifest();
    const merged = mergeVideoManifest(current, rendered);
    expect(merged.variants.default.assets[0]).toEqual(header);
    expect(
      Object.values(merged.variants)
        .flatMap((variant) => variant.assets)
        .filter((asset) => asset.placement === 'search-results'),
    ).toHaveLength(20);
    rendered.variants.tension.assets.pop();
    expect(() => mergeVideoManifest(current, rendered)).toThrow('Incomplete');
  });
  it('rejects a posterless set and changed storage configuration', () => {
    const current = renderedManifest();
    const rendered = renderedManifest();
    delete rendered.variants.kilter.assets[0].posterSha256;
    expect(() => mergeVideoManifest(current, rendered)).toThrow('Incomplete');
    rendered.storage.baseUrl = 'https://other.example';
    expect(() => mergeVideoManifest(current, rendered)).toThrow('storage');
  });
  it('embeds 20 durable candidate posters and exact video/provenance links', () => {
    const body = videoReviewBody(
      renderedManifest(),
      '2.6.0',
      'd'.repeat(40),
      'https://github.com/boardsesh/boardsesh/actions/runs/1',
    );
    expect(body.match(/!\[/g)).toHaveLength(20);
    expect(body.match(/\[Play video\]/g)).toHaveLength(20);
    expect(body).toContain(`/candidates/${'a'.repeat(64)}.mp4`);
    expect(body).toContain('Apple asset-review submission remains manual');
  });
});
