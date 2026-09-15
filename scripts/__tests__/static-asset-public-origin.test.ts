/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { ASSETS_HOSTNAME, ASSETS_STAGING_HOSTNAME } from '../../infra/cloudflare/config';
import { STATIC_ASSET_ORIGIN } from '../../packages/shared/static-assets/src';
import {
  assertCorsHeaderWithoutOrigin,
  expectsCloudflareOrigin,
  resolvePublicStaticAssetOrigin,
} from '../upload-static-assets';
import type { StaticAssetRecord } from '../../packages/shared/static-assets/src';

describe('resolvePublicStaticAssetOrigin', () => {
  it('defaults to the baked catalogue origin', () => {
    expect(resolvePublicStaticAssetOrigin({})).toBe(STATIC_ASSET_ORIGIN);
  });

  it('takes the staging override, without a trailing slash', () => {
    expect(resolvePublicStaticAssetOrigin({ STATIC_ASSETS_PUBLIC_BASE_URL: 'https://assets-r2.boardsesh.com/' })).toBe(
      'https://assets-r2.boardsesh.com',
    );
  });

  it('ignores a blank override rather than building "undefined/key" URLs', () => {
    expect(resolvePublicStaticAssetOrigin({ STATIC_ASSETS_PUBLIC_BASE_URL: '   ' })).toBe(STATIC_ASSET_ORIGIN);
  });
});

describe('expectsCloudflareOrigin', () => {
  it('is true for a hostname declared as an R2 custom domain', () => {
    // The staging hostname is where the bucket is proved, and it is Cloudflare
    // from the moment it is attached.
    expect(expectsCloudflareOrigin(`https://${ASSETS_STAGING_HOSTNAME}`)).toBe(true);
  });

  it('is false for assets.boardsesh.com until the bucket actually moves there', () => {
    // This is the whole point of deriving it from desiredR2Buckets instead of an
    // env flag: today the hostname is a DNS-only Tigris CNAME that sends no
    // cf-ray, and the assertion must stay off. The commit that repoints the
    // bucket's customDomain turns it on, with no second thing to remember.
    expect(expectsCloudflareOrigin(`https://${ASSETS_HOSTNAME}`)).toBe(false);
  });

  it('is false for an unparseable origin rather than throwing mid-publish', () => {
    expect(expectsCloudflareOrigin('not a url')).toBe(false);
  });
});

describe('assertCorsHeaderWithoutOrigin', () => {
  const asset = { logicalPath: '/images/kilter/full.webp', objectKey: 'static/v1/abc.webp' } as StaticAssetRecord;
  const noop = async () => {};

  function reply(headers: Record<string, string>, status = 200): typeof fetch {
    return (async () => new Response(null, { status, headers })) as unknown as typeof fetch;
  }

  it('sends no Origin header — which is the entire point of the probe', async () => {
    // The per-asset validation always sends `Origin`, so it cannot see the
    // failure this guards: R2 answers CORS only when one is present, and the
    // header-less response is cacheable and gets served to the board-render
    // worker's fetch().
    const calls: RequestInit[] = [];
    const spy = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(null, { status: 200, headers: { 'access-control-allow-origin': '*' } });
    }) as unknown as typeof fetch;

    await assertCorsHeaderWithoutOrigin([asset], noop, spy, 'https://assets-r2.boardsesh.com');

    expect(calls).toHaveLength(1);
    expect(calls[0].headers).toBeUndefined();
  });

  it('passes when the response carries ACAO without an Origin request header', async () => {
    await expect(
      assertCorsHeaderWithoutOrigin([asset], noop, reply({ 'access-control-allow-origin': '*' }), 'https://x.test'),
    ).resolves.toBeUndefined();
  });

  it('fails, naming the consequence, when the response has no ACAO', async () => {
    await expect(assertCorsHeaderWithoutOrigin([asset], noop, reply({}), 'https://x.test')).rejects.toThrow(
      'boards would render',
    );
  });

  it('retries a transient 503, so one CDN blip cannot reject a deploy', async () => {
    // This runs inside sync-static-assets, which gates every downstream
    // production job. A momentary edge failure must not fail the deployment.
    let calls = 0;
    const flaky = (async () => {
      calls += 1;
      return calls < 3
        ? new Response(null, { status: 503 })
        : new Response(null, { status: 200, headers: { 'access-control-allow-origin': '*' } });
    }) as unknown as typeof fetch;

    await expect(assertCorsHeaderWithoutOrigin([asset], noop, flaky, 'https://x.test')).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it('does NOT retry a successful response that is missing the header', async () => {
    // A 200 with no ACAO is a configuration error, not a blip. Retrying it would
    // only delay the message by the whole backoff ladder.
    let calls = 0;
    const missing = (async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    await expect(assertCorsHeaderWithoutOrigin([asset], noop, missing, 'https://x.test')).rejects.toThrow(
      'boards would render',
    );
    expect(calls).toBe(1);
  });

  it('fails immediately on a permanent 4xx, without burning the retry ladder', async () => {
    // 403 is non-retryable (unlike 404 and 429, which the CDN can answer
    // transiently while a new object propagates). Headers are never read off an
    // error page either way.
    let calls = 0;
    const forbidden = (async () => {
      calls += 1;
      return new Response(null, { status: 403 });
    }) as unknown as typeof fetch;

    await expect(assertCorsHeaderWithoutOrigin([asset], noop, forbidden, 'https://x.test')).rejects.toThrow('HTTP 403');
    expect(calls).toBe(1);
  });
});
