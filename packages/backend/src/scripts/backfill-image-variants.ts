/**
 * Generate the resized image variants that direct-from-bucket serving needs.
 *
 * While `/static/*` proxied every byte, a `?size=N` request could resize on the
 * fly and (for immutable keys) cache the result. Serving the object store
 * directly has no resizer: every size a client can ask for must already exist
 * as an object, or the request 404s.
 *
 * Two different rules, because the keys differ in kind:
 *
 * - `beta-link-thumbnails/` is keyed by the social media id, so the bytes never
 *   change and the variant is safe to keep forever. Only 280 is ever requested
 *   (BETA_THUMBNAIL_REQUEST_SIZE), and the proxy has been caching that size
 *   lazily on first view — so the gap here is exactly the thumbnails nobody has
 *   looked at yet.
 * - `avatars/`, `gym-logos/` and `gym-photos/` are overwritten in place on
 *   re-upload, which is why the proxy deliberately never cached a variant for
 *   them (a stale variant would shadow a new image). Direct serving removes
 *   that option, so every allowed size is generated and the `?v=` cache buster
 *   already in the stored URL is what keeps a replacement visible.
 *
 * Idempotent: a variant that already exists is skipped, so this is safe to
 * re-run and safe to interrupt.
 *
 * Usage:
 *   vp exec tsx packages/backend/src/scripts/backfill-image-variants.ts --dry-run
 *   vp exec tsx packages/backend/src/scripts/backfill-image-variants.ts --prefix avatars/
 */

import { ALLOWED_IMAGE_SIZES, BETA_THUMBNAIL_REQUEST_SIZE, type AllowedImageSize } from '@boardsesh/shared-schema';
import { resizeImageBuffer, resizedVariantKey, streamToBuffer } from '../lib/image-resize';
import { getFromS3, listS3Objects, uploadToS3 } from '../storage/s3';
import { logger } from '../utils/logger';

type VariantRule = Readonly<{
  prefix: string;
  sizes: readonly AllowedImageSize[];
  cacheControl: string;
}>;

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** Matches what the proxy served for avatars and gym images, so a client that drops `?v=` self-heals within a day. */
const MUTABLE_CACHE_CONTROL = 'public, max-age=86400';

const VARIANT_RULES: readonly VariantRule[] = [
  { prefix: 'beta-link-thumbnails/', sizes: [BETA_THUMBNAIL_REQUEST_SIZE], cacheControl: IMMUTABLE_CACHE_CONTROL },
  { prefix: 'avatars/', sizes: ALLOWED_IMAGE_SIZES, cacheControl: MUTABLE_CACHE_CONTROL },
  { prefix: 'gym-logos/', sizes: ALLOWED_IMAGE_SIZES, cacheControl: MUTABLE_CACHE_CONTROL },
  { prefix: 'gym-photos/', sizes: ALLOWED_IMAGE_SIZES, cacheControl: MUTABLE_CACHE_CONTROL },
];

const DEFAULT_CONCURRENCY = 8;

type Options = Readonly<{ dryRun: boolean; prefixFilters: readonly string[]; concurrency: number }>;

function parseOptions(argv: readonly string[]): Options {
  const prefixFilters: string[] = [];
  let concurrency = DEFAULT_CONCURRENCY;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') continue;
    if (argument === '--prefix') {
      const value = argv[index + 1];
      if (!value) throw new Error('--prefix requires a value');
      prefixFilters.push(value);
      index += 1;
      continue;
    }
    if (argument === '--concurrency') {
      concurrency = Number(argv[index + 1]);
      if (!Number.isInteger(concurrency) || concurrency <= 0)
        throw new Error('--concurrency must be a positive integer');
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { dryRun: argv.includes('--dry-run'), prefixFilters, concurrency };
}

/** A key that is itself a variant, e.g. `avatars/u1.jpg@64.jpg`. */
function isVariantKey(key: string): boolean {
  return /@\d+\.jpg$/.test(key);
}

async function withConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    }),
  );
}

type PendingVariant = Readonly<{ baseKey: string; size: AllowedImageSize; cacheControl: string }>;

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const rules = VARIANT_RULES.filter(
    (rule) =>
      options.prefixFilters.length === 0 ||
      options.prefixFilters.some((filter) => rule.prefix.startsWith(filter) || filter.startsWith(rule.prefix)),
  );

  const pending: PendingVariant[] = [];
  const emptySources: string[] = [];

  for (const rule of rules) {
    const objects = await listS3Objects('media', rule.prefix);
    const present = new Set(objects.map((object) => object.key));
    const bases = objects.filter((object) => !isVariantKey(object.key));

    let rulePending = 0;
    for (const base of bases) {
      // sharp throws on an empty buffer, and a zero-byte source is a broken
      // upload rather than something a variant can be made from.
      if (base.size === 0) {
        emptySources.push(base.key);
        continue;
      }
      for (const size of rule.sizes) {
        if (present.has(resizedVariantKey(base.key, size))) continue;
        pending.push({ baseKey: base.key, size, cacheControl: rule.cacheControl });
        rulePending += 1;
      }
    }
    logger.info(
      `[backfill-variants] ${rule.prefix}: ${bases.length} base objects, sizes [${rule.sizes.join(', ')}], ${rulePending} variant(s) to generate`,
    );
  }

  if (emptySources.length > 0) {
    logger.warn(`[backfill-variants] skipped ${emptySources.length} zero-byte source object(s)`);
  }
  if (options.dryRun) {
    logger.info(`[backfill-variants] dry run: ${pending.length} variant(s) would be generated`);
    return;
  }
  if (pending.length === 0) {
    logger.info('[backfill-variants] nothing to generate');
    return;
  }

  let generated = 0;
  let failed = 0;
  const startedAt = Date.now();

  await withConcurrency(pending, options.concurrency, async (variant) => {
    try {
      const original = await getFromS3('media', variant.baseKey);
      if (!original) {
        failed += 1;
        logger.warn(`[backfill-variants] base object vanished: ${variant.baseKey}`);
        return;
      }
      const body = await resizeImageBuffer(await streamToBuffer(original.stream), variant.size);
      await uploadToS3('media', body, resizedVariantKey(variant.baseKey, variant.size), 'image/jpeg', {
        cacheControl: variant.cacheControl,
      });
      generated += 1;
      if (generated % 500 === 0) {
        const rate = generated / Math.max((Date.now() - startedAt) / 1000, 0.001);
        logger.info(`[backfill-variants] ${generated}/${pending.length} · ${rate.toFixed(1)}/s`);
      }
    } catch (error) {
      // One unreadable source must not abort the run; it is reported and the
      // re-run picks it up if it was transient.
      failed += 1;
      logger.warn(`[backfill-variants] failed ${variant.baseKey}@${variant.size}:`, error);
    }
  });

  logger.info(
    `[backfill-variants] done: ${generated} generated, ${failed} failed, ${Math.round((Date.now() - startedAt) / 1000)}s`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  logger.error('[backfill-variants] fatal:', error);
  process.exit(1);
});
