// Resolves the S3-compatible configuration for each named storage bucket from
// the environment. Pure: no SDK construction, no network, no module state — so
// every resolution rule below is unit-testable by passing an env object in.
//
// Why named buckets at all. Before this module existed,
// `storage/s3.ts` held ONE module-level client keyed to the bare `AWS_*`
// variables. Three different buckets were already riding on those five names,
// distinguished only by which process happened to be running:
//
//   - the Railway backend and web services  → the Railway object-storage bucket
//   - the export-board-snapshots GitHub job → the Tigris board-snapshots bucket
//
// That worked only because no single process ever needed two of them. Splitting
// user media (public, CDN-served) from user exports (private) breaks that
// assumption, so the bucket became an explicit argument and each one got its
// own env prefix.

import type { ObjectCannedACL } from '@aws-sdk/client-s3';

/**
 * Just the shape these readers need: arbitrary string keys.
 *
 * Deliberately not the global process-env type, which this repo augments with
 * required keys — a caller passing a fixture of a few variables should not
 * have to satisfy them.
 */
export type EnvironmentSource = Readonly<Record<string, string | undefined>>;

/**
 * The storage buckets this backend knows about.
 *
 * - `media`     — public, CDN-served: avatars, gym logos/photos, beta-link
 *                 thumbnails and their `@<size>.jpg` resize variants.
 * - `private`   — never publicly reachable: user data exports (a user's whole
 *                 tick history) and MoonBoard OCR test submissions.
 * - `snapshots` — the board-catalogue SQLite artifacts published to the mobile
 *                 fleet. Written only by the two export scripts, never by a
 *                 request handler.
 */
export type StorageBucket = 'media' | 'private' | 'snapshots';

export const STORAGE_BUCKETS: readonly StorageBucket[] = ['media', 'private', 'snapshots'];

/** Env-var prefix owning each bucket's configuration, e.g. `MEDIA_S3_BUCKET_NAME`. */
export const BUCKET_ENV_PREFIX: Readonly<Record<StorageBucket, string>> = {
  media: 'MEDIA',
  private: 'PRIVATE',
  snapshots: 'SNAPSHOTS',
};

export type BucketConfig = Readonly<{
  bucketName: string;
  endpointUrl: string | null;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /**
   * Browser-reachable base for public objects, without a trailing slash.
   *
   * Mandatory for any bucket whose objects are served to clients directly.
   * Cloudflare R2 has no unauthenticated URL on its S3 endpoint at all
   * (`https://<account>.r2.cloudflarestorage.com/...` requires SigV4), so for
   * an R2 bucket there is no derivable fallback — `getPublicUrl` throws rather
   * than hand back a URL that always 401s.
   */
  publicBaseUrl: string | null;
  /**
   * ACL sent on PutObject when the caller passes no override. `null` means the
   * `ACL` key is omitted entirely.
   *
   * Load-bearing for R2: it implements no ACLs and answers
   * `x-amz-acl: public-read` with `501 NotImplemented`, so a default of
   * `public-read` (what this code did before named buckets) fails every single
   * upload. R2 object visibility comes from whether the bucket has a custom
   * domain attached, not from a per-object header.
   */
  defaultAcl: ObjectCannedACL | null;
  /** Which env source supplied this config. Surfaced in the startup log and asserted in tests. */
  source: 'prefixed' | 'legacy';
}>;

/**
 * Default ACL per bucket in LEGACY mode — the behaviour that predates named
 * buckets, preserved so a deploy without the new variables changes nothing.
 *
 * `private` is the one deliberate deviation. The old single-client module sent
 * `public-read` on every upload that did not override it, which for this
 * handle means the OCR test-data path (`handlers/ocr-test-data.ts`). That was
 * harmless only because the Railway bucket ignores ACLs outright; pointed at a
 * store that honours them, it would publish user-submitted screenshots. The
 * other private caller (`services/user-data-export.ts`) already passes
 * `acl: null` explicitly, so nothing relies on the old default here.
 */
const LEGACY_DEFAULT_ACL: Readonly<Record<StorageBucket, ObjectCannedACL | null>> = {
  media: 'public-read',
  private: null,
  snapshots: 'public-read',
};

function readTrimmed(env: EnvironmentSource, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Parses an optional boolean env var. Anything other than a recognised literal is a hard error. */
function readBoolean(env: EnvironmentSource, name: string, fallback: boolean): boolean {
  const raw = readTrimmed(env, name);
  if (raw === undefined) return fallback;
  const normalized = raw.toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(`${name} must be 'true' or 'false' (got '${raw}')`);
}

/** Strips trailing slashes so callers can always join with a single `/`. */
function normalizeBaseUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  return value.replace(/\/+$/, '');
}

/** Hosts where plain HTTP is a legitimate local-development choice. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Validate a public base URL at read time.
 *
 * Every value this produces is persisted into a database column or served in
 * an `<img src>`, so an `http://` typo does not fail loudly — it quietly
 * downgrades every avatar and thumbnail on the site and mixed-content-blocks
 * them in the browser. Catching it at boot is the only cheap moment.
 */
function assertUsablePublicBaseUrl(name: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL (got '${value}')`);
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && LOCAL_HOSTNAMES.has(parsed.hostname)) return;
  throw new Error(`${name} must be https (got '${parsed.protocol}//${parsed.host}')`);
}

/**
 * True for a Cloudflare R2 S3 endpoint.
 *
 * R2 implements no ACLs and answers `x-amz-acl` with `501 NotImplemented`, so
 * an R2 bucket that has not been told to suppress ACLs fails 100% of its
 * uploads. Nothing is gained by making that depend on an operator remembering
 * a flag, so the endpoint decides the default and the flag stays an override.
 */
function isR2Endpoint(endpointUrl: string | null): boolean {
  if (!endpointUrl) return false;
  try {
    return new URL(endpointUrl).hostname.endsWith('.r2.cloudflarestorage.com');
  } catch {
    return false;
  }
}

/**
 * True when this bucket has its own `<PREFIX>_S3_BUCKET_NAME`, which is what
 * selects prefixed mode over the legacy `AWS_*` fallback.
 */
function hasPrefixedConfig(bucket: StorageBucket, env: EnvironmentSource): boolean {
  return readTrimmed(env, `${BUCKET_ENV_PREFIX[bucket]}_S3_BUCKET_NAME`) !== undefined;
}

/**
 * Reads a bucket's configuration in prefixed mode.
 *
 * Credentials are required rather than optional on purpose: falling back to
 * `AWS_ACCESS_KEY_ID` when only `<PREFIX>_S3_BUCKET_NAME` is set would point
 * one bucket's name at another bucket's credentials, which fails at request
 * time with an opaque 403 instead of at boot with a readable message.
 */
function readPrefixedConfig(bucket: StorageBucket, env: EnvironmentSource): BucketConfig {
  const prefix = BUCKET_ENV_PREFIX[bucket];
  const bucketName = readTrimmed(env, `${prefix}_S3_BUCKET_NAME`);
  const accessKeyId = readTrimmed(env, `${prefix}_AWS_ACCESS_KEY_ID`);
  const secretAccessKey = readTrimmed(env, `${prefix}_AWS_SECRET_ACCESS_KEY`);

  if (!bucketName) {
    throw new Error(`${prefix}_S3_BUCKET_NAME is not set`);
  }
  if (!accessKeyId || !secretAccessKey) {
    const missing = [
      accessKeyId ? null : `${prefix}_AWS_ACCESS_KEY_ID`,
      secretAccessKey ? null : `${prefix}_AWS_SECRET_ACCESS_KEY`,
    ].filter((name): name is string => name !== null);
    throw new Error(
      `${prefix}_S3_BUCKET_NAME is set but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing. ` +
        `Prefixed buckets never fall back to the legacy AWS_* credentials — set every ${prefix}_* variable together.`,
    );
  }

  // Accept the storage console's own exported names as aliases, the same habit
  // scripts/upload-static-assets.ts has, so rotating a key stays copy-paste.
  //
  // `auto` is the right default for the S3-compatible stores we actually use
  // (R2 and Tigris both want it) but would be nonsense in an AWS URL. That
  // never happens: getPublicUrl refuses to build an amazonaws.com URL for a
  // prefixed bucket at all — it demands <PREFIX>_PUBLIC_BASE_URL instead.
  const region = readTrimmed(env, `${prefix}_AWS_REGION`) ?? readTrimmed(env, `${prefix}_AWS_DEFAULT_REGION`) ?? 'auto';
  const endpointUrl =
    normalizeBaseUrl(readTrimmed(env, `${prefix}_AWS_ENDPOINT_URL`)) ??
    normalizeBaseUrl(readTrimmed(env, `${prefix}_AWS_ENDPOINT_URL_S3`));

  const publicBaseUrl = normalizeBaseUrl(readTrimmed(env, `${prefix}_PUBLIC_BASE_URL`));
  if (publicBaseUrl !== null) {
    assertUsablePublicBaseUrl(`${prefix}_PUBLIC_BASE_URL`, publicBaseUrl);
  }

  // No ACL by default when the store cannot accept one (R2), or when the
  // bucket's whole purpose is that nobody else can read it. Both stay
  // overridable through <PREFIX>_DISABLE_ACL.
  const aclDisabledByDefault = bucket === 'private' || isR2Endpoint(endpointUrl);

  return {
    bucketName,
    endpointUrl,
    region,
    accessKeyId,
    secretAccessKey,
    // Virtual-hosted is the S3 standard and what both R2 and Tigris prefer.
    // Legacy mode keeps path-style (see readLegacyConfig) for the Railway bucket.
    forcePathStyle: readBoolean(env, `${prefix}_S3_FORCE_PATH_STYLE`, false),
    publicBaseUrl,
    defaultAcl: readBoolean(env, `${prefix}_DISABLE_ACL`, aclDisabledByDefault) ? null : 'public-read',
    source: 'prefixed',
  };
}

/**
 * Reads the pre-named-buckets `AWS_*` configuration, reproducing the old
 * single-client behaviour bit for bit — including `forcePathStyle: true` and
 * the `us-east-1` region default — so deploying the refactor without setting
 * any new variable is a genuine no-op.
 */
function readLegacyConfig(bucket: StorageBucket, env: EnvironmentSource): BucketConfig | null {
  const bucketName = readTrimmed(env, 'AWS_S3_BUCKET_NAME');
  const accessKeyId = readTrimmed(env, 'AWS_ACCESS_KEY_ID');
  const secretAccessKey = readTrimmed(env, 'AWS_SECRET_ACCESS_KEY');
  if (!bucketName || !accessKeyId || !secretAccessKey) return null;

  return {
    bucketName,
    endpointUrl: normalizeBaseUrl(readTrimmed(env, 'AWS_ENDPOINT_URL')),
    region: readTrimmed(env, 'AWS_DEFAULT_REGION') ?? readTrimmed(env, 'AWS_REGION') ?? 'us-east-1',
    accessKeyId,
    secretAccessKey,
    forcePathStyle: true,
    publicBaseUrl: null,
    defaultAcl: LEGACY_DEFAULT_ACL[bucket],
    source: 'legacy',
  };
}

/**
 * Resolve a bucket's configuration, or null when it is not configured at all
 * (the local-development case, where handlers fall back to the filesystem).
 *
 * Throws — rather than returning null — when a bucket is half-configured, because
 * a half-configured bucket is a deployment mistake and silently degrading to
 * local disk in production would hide it.
 */
export function readBucketConfig(bucket: StorageBucket, env: EnvironmentSource = process.env): BucketConfig | null {
  if (hasPrefixedConfig(bucket, env)) {
    return readPrefixedConfig(bucket, env);
  }
  return readLegacyConfig(bucket, env);
}

/** True when this bucket has a usable configuration. Never throws. */
export function isBucketConfigured(bucket: StorageBucket, env: EnvironmentSource = process.env): boolean {
  try {
    return readBucketConfig(bucket, env) !== null;
  } catch {
    // A half-configured bucket is "configured enough" to be a mistake worth
    // surfacing; the throw happens when something actually reaches for a client.
    return true;
  }
}

/** One-line summary for the startup log. Never includes credentials. */
export function describeBucketConfig(bucket: StorageBucket, config: BucketConfig): string {
  const endpoint = config.endpointUrl ?? 'aws';
  const publicBase = config.publicBaseUrl ?? 'none';
  return (
    `storage[${bucket}] bucket=${config.bucketName} source=${config.source} endpoint=${endpoint} ` +
    `region=${config.region} pathStyle=${config.forcePathStyle} acl=${config.defaultAcl ?? 'none'} public=${publicBase}`
  );
}
