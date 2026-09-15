/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import { ASSETS_HOSTNAME, ASSETS_STAGING_HOSTNAME } from '../../infra/cloudflare/config';
import { STATIC_ASSET_ORIGIN } from '../../packages/shared/static-assets/src';
import { expectsCloudflareOrigin, resolvePublicStaticAssetOrigin } from '../upload-static-assets';

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
