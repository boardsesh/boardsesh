import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  appleList,
  appleToken,
  editableVersion,
  missingLiveActivityFootage,
  parseVariantSelection,
  parseVideoSource,
  sourceStillOnTrain,
  storeVideoSelection,
} from '../store-videos-gate';
import { carryOpenReview, mergeVideoManifest, videoReviewBody } from '../store-videos-publish';
import { STORE_SEARCH_VARIANTS, storeSearchTakeIds } from '../lib/showcase-video/store-search';
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

describe('store video variant selection', () => {
  const known = ['default', 'kilter', 'tension', 'moonboard', 'spray'];
  it('expands all or nothing to every variant and keeps canonical order for a list', () => {
    expect(parseVariantSelection('all', known)).toEqual(known);
    expect(parseVariantSelection(undefined, known)).toEqual(known);
    expect(parseVariantSelection('', known)).toEqual(known);
    expect(parseVariantSelection('default', known)).toEqual(['default']);
    expect(parseVariantSelection(' spray , default ', known)).toEqual(['default', 'spray']);
  });
  it.each(['kilterx', 'default,', ',default', 'default,default', 'all,default', 'Default'])(
    'rejects %j before any recording',
    (input) => {
      expect(() => parseVariantSelection(input, known)).toThrow();
    },
  );
  it('derives crew, Live Activity endings and footage families from the storyboards', () => {
    const takes: Record<string, string[]> = {
      default: ['boards', 'crew', 'spray', 'log'],
      kilter: ['boards-kilter', 'crew', 'lock-screen'],
      tension: ['boards-tension', 'crew', 'lock-screen'],
      moonboard: ['boards-moonboard'],
      spray: ['spray'],
    };
    expect(storeVideoSelection('default', known, (variant) => takes[variant])).toEqual({
      variants: ['default'],
      crew: ['default'],
      liveActivity: [],
      footage: [],
    });
    expect(storeVideoSelection('spray,moonboard', known, (variant) => takes[variant])).toEqual({
      variants: ['moonboard', 'spray'],
      crew: [],
      liveActivity: [],
      footage: [],
    });
    takes.default.push('lock-screen');
    expect(storeVideoSelection('all', known, (variant) => takes[variant]).footage).toEqual(['kilter', 'tension']);
    expect(storeVideoSelection('default', known, (variant) => takes[variant]).footage).toEqual(['kilter']);
  });
  it('matches the current storyboards for every variant', () => {
    const selection = storeVideoSelection('all', STORE_SEARCH_VARIANTS, (variant) =>
      storeSearchTakeIds(variant as (typeof STORE_SEARCH_VARIANTS)[number]),
    );
    expect(selection.variants).toEqual([...STORE_SEARCH_VARIANTS]);
    for (const variant of STORE_SEARCH_VARIANTS) {
      const takes = storeSearchTakeIds(variant);
      expect(selection.crew.includes(variant)).toBe(takes.includes('crew'));
      expect(selection.liveActivity.includes(variant)).toBe(takes.includes('lock-screen'));
    }
  });
  it('checks reviewed footage only for the families a selection needs', () => {
    const sha = 'e'.repeat(64);
    const kilter = { boardFamily: 'kilter', sha256: sha, key: `sources/live-activity/${sha}.zip` };
    expect(missingLiveActivityFootage({ footage: {} }, [])).toEqual([]);
    expect(missingLiveActivityFootage({ footage: {} }, ['kilter', 'tension'])).toEqual(['kilter', 'tension']);
    expect(missingLiveActivityFootage({ footage: { kilter } }, ['kilter', 'tension'])).toEqual(['tension']);
    expect(
      missingLiveActivityFootage({ footage: { kilter: { ...kilter, boardFamily: 'tension' } } }, ['kilter']),
    ).toEqual(['kilter']);
    expect(
      missingLiveActivityFootage({ footage: { kilter: { ...kilter, key: 'elsewhere.zip' } } }, ['kilter']),
    ).toEqual(['kilter']);
    expect(missingLiveActivityFootage(null, ['kilter'])).toEqual(['kilter']);
  });
});

describe('subset video review manifest', () => {
  const search = (manifest: CreativeManifest, variant: string) =>
    manifest.variants[variant].assets.filter((asset) => asset.placement === 'search-results');
  it('replaces only the recorded variants and leaves the others exactly as main has them', () => {
    const current = renderedManifest();
    const shipped = structuredClone(current.variants.kilter);
    current.variants.default.assets = [];
    current.variants.tension.assets = [];
    const rendered = renderedManifest();
    for (const variant of ['kilter', 'tension', 'moonboard', 'spray']) rendered.variants[variant].assets = [];
    rendered.variants.default.assets[0].sha256 = 'f'.repeat(64);
    const merged = mergeVideoManifest(current, rendered, ['default']);
    expect(search(merged, 'default')).toHaveLength(4);
    expect(search(merged, 'default')[0].sha256).toBe('f'.repeat(64));
    expect(merged.variants.kilter).toEqual(shipped);
    expect(merged.variants.tension.assets).toEqual([]);
    rendered.variants.default.assets.pop();
    expect(() => mergeVideoManifest(current, rendered, ['default'])).toThrow(
      'Incomplete video/poster matrix for default',
    );
    expect(() => mergeVideoManifest(current, renderedManifest(), [])).toThrow('non-empty');
    expect(() => mergeVideoManifest(current, renderedManifest(), ['header'])).toThrow('non-empty');
  });
  it('carries an earlier subset run of the same train on the open review branch', () => {
    const main = renderedManifest();
    for (const configuration of Object.values(main.variants)) configuration.assets = [];
    const header = {
      ...renderedManifest().variants.spray.assets[0],
      placement: 'header' as const,
      file: '.boardsesh/app-store-creatives/spray/en-US/header.png',
    };
    main.variants.spray.assets = [header];
    const review = { ...renderedManifest(), marketingVersion: '2.7.0' };
    for (const variant of ['kilter', 'tension', 'moonboard']) review.variants[variant].assets = [];
    const { manifest, carried } = carryOpenReview(main, review, '2.7.0', ['kilter']);
    expect(carried).toEqual(['default', 'spray']);
    expect(manifest.variants.spray.assets[0]).toEqual(header);
    expect(search(manifest, 'spray')).toHaveLength(4);
    expect(manifest.variants.kilter.assets).toEqual([]);
    expect(carryOpenReview(main, { ...review, marketingVersion: '2.6.0' }, '2.7.0', ['kilter']).carried).toEqual([]);
    expect(carryOpenReview(main, undefined, '2.7.0', ['kilter']).manifest).toBe(main);
  });
  it('lists only the reviewed variants in the PR body', () => {
    const manifest = renderedManifest();
    const body = videoReviewBody(manifest, '2.7.0', 'd'.repeat(40), 'https://example.com/run', ['default']);
    expect(body).toContain('Review 4 Search Results videos (default) for train v2.7.0.');
    expect(body).toContain('Not in this review: kilter, tension, moonboard, spray.');
    expect(body.match(/\[Play video\]/g)).toHaveLength(4);
    expect(body).not.toContain('| kilter |');
    expect(videoReviewBody(manifest, '2.7.0', 'd'.repeat(40), 'https://example.com/run')).not.toContain(
      'Not in this review',
    );
  });
});
