import { describe, expect, it } from 'vite-plus/test';
import { describeBucketConfig, isBucketConfigured, readBucketConfig, type StorageBucket } from '../bucket-config';

/** The pre-named-buckets environment. Every handle must still resolve from it. */
const LEGACY: Record<string, string> = {
  AWS_S3_BUCKET_NAME: 'structured-parcel-ei3jl8g',
  AWS_ENDPOINT_URL: 'https://t3.storageapi.dev',
  AWS_DEFAULT_REGION: 'sjc',
  AWS_ACCESS_KEY_ID: 'legacy-key',
  AWS_SECRET_ACCESS_KEY: 'legacy-secret',
};

const R2_MEDIA: Record<string, string> = {
  MEDIA_S3_BUCKET_NAME: 'boardsesh-user-media',
  MEDIA_AWS_ENDPOINT_URL: 'https://acct123.r2.cloudflarestorage.com',
  MEDIA_AWS_REGION: 'auto',
  MEDIA_AWS_ACCESS_KEY_ID: 'media-key',
  MEDIA_AWS_SECRET_ACCESS_KEY: 'media-secret',
  MEDIA_DISABLE_ACL: 'true',
  MEDIA_PUBLIC_BASE_URL: 'https://media.boardsesh.com',
};

describe('readBucketConfig — legacy AWS_* fallback', () => {
  // This block is the deploy-safety contract: shipping the named-bucket
  // refactor without setting a single new variable must not change behaviour.

  it.each<StorageBucket>(['media', 'snapshots'])('resolves %s from the bare AWS_* names', (bucket) => {
    const config = readBucketConfig(bucket, LEGACY);

    expect(config).toEqual({
      bucketName: 'structured-parcel-ei3jl8g',
      endpointUrl: 'https://t3.storageapi.dev',
      region: 'sjc',
      accessKeyId: 'legacy-key',
      secretAccessKey: 'legacy-secret',
      // Railway's object storage needs path-style; keeping this true is what
      // makes the fallback byte-identical to the old single-client module.
      forcePathStyle: true,
      publicBaseUrl: null,
      defaultAcl: 'public-read',
      source: 'legacy',
    });
  });

  it('resolves private from the bare AWS_* names, but never defaults it public', () => {
    // The one deliberate deviation from bit-for-bit legacy fidelity: the old
    // module sent public-read on any upload that did not override it, which is
    // wrong for a bucket whose whole purpose is that nobody else can read it.
    expect(readBucketConfig('private', LEGACY)).toEqual({
      bucketName: 'structured-parcel-ei3jl8g',
      endpointUrl: 'https://t3.storageapi.dev',
      region: 'sjc',
      accessKeyId: 'legacy-key',
      secretAccessKey: 'legacy-secret',
      forcePathStyle: true,
      publicBaseUrl: null,
      defaultAcl: null,
      source: 'legacy',
    });
  });

  it('keeps the old us-east-1 region default and AWS_REGION alias', () => {
    const { AWS_DEFAULT_REGION: _dropped, ...noRegion } = LEGACY;
    expect(readBucketConfig('media', noRegion)?.region).toBe('us-east-1');
    expect(readBucketConfig('media', { ...noRegion, AWS_REGION: 'auto' })?.region).toBe('auto');
  });

  it('returns null when nothing is configured, so handlers fall back to local disk', () => {
    expect(readBucketConfig('media', {})).toBeNull();
    expect(isBucketConfigured('media', {})).toBe(false);
  });

  it('returns null when the legacy set is incomplete', () => {
    const { AWS_SECRET_ACCESS_KEY: _dropped, ...partial } = LEGACY;
    expect(readBucketConfig('media', partial)).toBeNull();
  });
});

describe('readBucketConfig — prefixed mode', () => {
  it('selects prefixed mode on <PREFIX>_S3_BUCKET_NAME alone', () => {
    const config = readBucketConfig('media', { ...LEGACY, ...R2_MEDIA });

    expect(config).toEqual({
      bucketName: 'boardsesh-user-media',
      endpointUrl: 'https://acct123.r2.cloudflarestorage.com',
      region: 'auto',
      accessKeyId: 'media-key',
      secretAccessKey: 'media-secret',
      forcePathStyle: false,
      publicBaseUrl: 'https://media.boardsesh.com',
      defaultAcl: null,
      source: 'prefixed',
    });
  });

  it('resolves each handle independently from the same environment', () => {
    const env = {
      ...LEGACY,
      ...R2_MEDIA,
      PRIVATE_S3_BUCKET_NAME: 'boardsesh-user-private',
      PRIVATE_AWS_ACCESS_KEY_ID: 'private-key',
      PRIVATE_AWS_SECRET_ACCESS_KEY: 'private-secret',
    };

    expect(readBucketConfig('media', env)?.bucketName).toBe('boardsesh-user-media');
    expect(readBucketConfig('private', env)?.bucketName).toBe('boardsesh-user-private');
    // No SNAPSHOTS_* prefix, so this one keeps using the legacy names — which
    // is exactly how the board-snapshots GitHub job keeps working untouched.
    expect(readBucketConfig('snapshots', env)?.bucketName).toBe('structured-parcel-ei3jl8g');
    expect(readBucketConfig('snapshots', env)?.source).toBe('legacy');
  });

  it('NEVER falls back to legacy credentials for a prefixed bucket', () => {
    // Mixing would point one bucket's name at another bucket's credentials and
    // fail at request time with an opaque 403 instead of at boot.
    expect(() => readBucketConfig('media', { ...LEGACY, MEDIA_S3_BUCKET_NAME: 'boardsesh-user-media' })).toThrow(
      /MEDIA_AWS_ACCESS_KEY_ID and MEDIA_AWS_SECRET_ACCESS_KEY are missing/,
    );
  });

  it('names the single missing credential when only one is absent', () => {
    const env = { ...LEGACY, ...R2_MEDIA };
    delete env.MEDIA_AWS_SECRET_ACCESS_KEY;
    expect(() => readBucketConfig('media', env)).toThrow(/MEDIA_AWS_SECRET_ACCESS_KEY is missing/);
  });

  it('defaults the private bucket to NO acl even without PRIVATE_DISABLE_ACL', () => {
    // Same rule as legacy mode: a bucket that exists so nobody else can read it
    // must not depend on remembering a flag to stay that way.
    const env = {
      ...LEGACY,
      PRIVATE_S3_BUCKET_NAME: 'boardsesh-user-private',
      PRIVATE_AWS_ACCESS_KEY_ID: 'private-key',
      PRIVATE_AWS_SECRET_ACCESS_KEY: 'private-secret',
    };
    expect(readBucketConfig('private', env)?.defaultAcl).toBeNull();
    // ...but it stays explicitly overridable in both directions.
    expect(readBucketConfig('private', { ...env, PRIVATE_DISABLE_ACL: 'false' })?.defaultAcl).toBe('public-read');
  });

  it('accepts the storage console exported names as aliases', () => {
    const env = { ...LEGACY, ...R2_MEDIA };
    delete env.MEDIA_AWS_ENDPOINT_URL;
    delete env.MEDIA_AWS_REGION;
    const config = readBucketConfig('media', {
      ...env,
      MEDIA_AWS_ENDPOINT_URL_S3: 'https://acct123.r2.cloudflarestorage.com',
      MEDIA_AWS_DEFAULT_REGION: 'wnam',
    });
    expect(config?.endpointUrl).toBe('https://acct123.r2.cloudflarestorage.com');
    expect(config?.region).toBe('wnam');
  });

  it('defaults the region to auto when a prefixed bucket names none', () => {
    const env = { ...LEGACY, ...R2_MEDIA };
    delete env.MEDIA_AWS_REGION;
    expect(readBucketConfig('media', env)?.region).toBe('auto');
  });

  it('strips trailing slashes so callers can always join with a single /', () => {
    const config = readBucketConfig('media', {
      ...LEGACY,
      ...R2_MEDIA,
      MEDIA_PUBLIC_BASE_URL: 'https://media.boardsesh.com///',
      MEDIA_AWS_ENDPOINT_URL: 'https://acct123.r2.cloudflarestorage.com/',
    });
    expect(config?.publicBaseUrl).toBe('https://media.boardsesh.com');
    expect(config?.endpointUrl).toBe('https://acct123.r2.cloudflarestorage.com');
  });

  it('treats a whitespace-only value as unset', () => {
    expect(readBucketConfig('media', { ...LEGACY, MEDIA_S3_BUCKET_NAME: '   ' })?.source).toBe('legacy');
  });

  it('rejects an unparseable boolean rather than guessing', () => {
    expect(() => readBucketConfig('media', { ...LEGACY, ...R2_MEDIA, MEDIA_DISABLE_ACL: 'yes' })).toThrow(
      /MEDIA_DISABLE_ACL must be 'true' or 'false'/,
    );
  });

  it('allows path-style to be forced back on for a prefixed bucket', () => {
    expect(
      readBucketConfig('media', { ...LEGACY, ...R2_MEDIA, MEDIA_S3_FORCE_PATH_STYLE: 'true' })?.forcePathStyle,
    ).toBe(true);
  });
});

describe('readBucketConfig — R2 endpoint detection', () => {
  it('suppresses ACLs for an R2 endpoint without needing the flag', () => {
    // R2 answers x-amz-acl with 501, so a media bucket that forgot
    // MEDIA_DISABLE_ACL would fail 100% of its uploads. The endpoint knows.
    const { MEDIA_DISABLE_ACL: _omitted, ...withoutFlag } = R2_MEDIA;
    expect(readBucketConfig('media', { ...LEGACY, ...withoutFlag })?.defaultAcl).toBeNull();
  });

  it('still sends ACLs for a non-R2 prefixed endpoint', () => {
    const { MEDIA_DISABLE_ACL: _omitted, ...withoutFlag } = R2_MEDIA;
    const env = { ...LEGACY, ...withoutFlag, MEDIA_AWS_ENDPOINT_URL: 'https://t3.storage.dev' };
    expect(readBucketConfig('media', env)?.defaultAcl).toBe('public-read');
  });

  it('does not match a lookalike hostname', () => {
    const { MEDIA_DISABLE_ACL: _omitted, ...withoutFlag } = R2_MEDIA;
    const env = {
      ...LEGACY,
      ...withoutFlag,
      MEDIA_AWS_ENDPOINT_URL: 'https://evil-r2.cloudflarestorage.com.example.net',
    };
    expect(readBucketConfig('media', env)?.defaultAcl).toBe('public-read');
  });
});

describe('readBucketConfig — public base URL validation', () => {
  it('rejects a plain-HTTP public base', () => {
    // Every value built from this is persisted or served in an <img src>, so
    // an http:// typo silently downgrades the whole site rather than failing.
    expect(() =>
      readBucketConfig('media', { ...LEGACY, ...R2_MEDIA, MEDIA_PUBLIC_BASE_URL: 'http://media.boardsesh.com' }),
    ).toThrow(/MEDIA_PUBLIC_BASE_URL must be https/);
  });

  it('rejects a value that is not an absolute URL', () => {
    expect(() =>
      readBucketConfig('media', { ...LEGACY, ...R2_MEDIA, MEDIA_PUBLIC_BASE_URL: 'media.boardsesh.com' }),
    ).toThrow(/must be an absolute URL/);
  });

  it('allows plain HTTP on localhost for development', () => {
    expect(
      readBucketConfig('media', { ...LEGACY, ...R2_MEDIA, MEDIA_PUBLIC_BASE_URL: 'http://localhost:9000/media' })
        ?.publicBaseUrl,
    ).toBe('http://localhost:9000/media');
  });
});

describe('isBucketConfigured', () => {
  it('reports a half-configured bucket as configured, so the mistake surfaces', () => {
    // Returning false here would silently degrade to local-disk storage in
    // production, which is a far worse failure than a loud throw at first use.
    expect(isBucketConfigured('media', { ...LEGACY, MEDIA_S3_BUCKET_NAME: 'boardsesh-user-media' })).toBe(true);
  });
});

describe('describeBucketConfig', () => {
  it('summarises the resolution without leaking credentials', () => {
    const config = readBucketConfig('media', { ...LEGACY, ...R2_MEDIA });
    const line = describeBucketConfig('media', config!);

    expect(line).toContain('bucket=boardsesh-user-media');
    expect(line).toContain('source=prefixed');
    expect(line).toContain('acl=none');
    expect(line).toContain('public=https://media.boardsesh.com');
    expect(line).not.toContain('media-secret');
    expect(line).not.toContain('media-key');
  });
});
