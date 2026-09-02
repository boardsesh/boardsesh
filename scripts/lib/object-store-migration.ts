/// <reference types="node" />

// Pure planning helpers for the one-shot copy of the Railway object-storage
// bucket into the two Cloudflare R2 buckets. No SDK, no I/O — the routing and
// planning rules are the part worth testing, and the part where a mistake
// silently publishes a user's data export to a CDN.

/** Destination handles this migration can route a key to. */
export type MigrationDestination = 'media' | 'private';

export type MigrationRoute = Readonly<{ prefix: string; destination: MigrationDestination }>;

/**
 * Every key prefix the legacy bucket is known to contain, and where it goes.
 *
 * `media` becomes publicly readable through the R2 custom domain, so anything
 * routed there is world-readable the moment PR 2 attaches that domain. That is
 * why this table is exhaustive and `classifyKey` returns null rather than
 * guessing: an unrecognised key must stop the migration, not land in whichever
 * bucket happens to be the default.
 *
 * `moonboard-ocr-test-data/` holds zero objects today but is written by
 * `packages/backend/src/handlers/ocr-test-data.ts`. It is user-submitted
 * MoonBoard app screenshots, so it is private.
 */
export const MIGRATION_ROUTES: readonly MigrationRoute[] = [
  { prefix: 'beta-link-thumbnails/', destination: 'media' },
  { prefix: 'avatars/', destination: 'media' },
  { prefix: 'gym-photos/', destination: 'media' },
  { prefix: 'gym-logos/', destination: 'media' },
  { prefix: 'user-data-exports/', destination: 'private' },
  { prefix: 'moonboard-ocr-test-data/', destination: 'private' },
];

/**
 * Route a key to its destination bucket, or null when no rule matches.
 *
 * Null is a hard stop for the caller, never a default.
 */
export function classifyKey(
  key: string,
  routes: readonly MigrationRoute[] = MIGRATION_ROUTES,
): MigrationDestination | null {
  for (const route of routes) {
    if (key.startsWith(route.prefix)) return route.destination;
  }
  return null;
}

export type ObjectSummary = Readonly<{ key: string; size: number }>;

export type PlannedCopy = Readonly<{
  key: string;
  destination: MigrationDestination;
  size: number;
  /** Why this object is in the plan: absent at the destination, or a size mismatch. */
  reason: 'missing' | 'size-mismatch';
  /** The destination's current size, when there is one. Only set for size-mismatch. */
  destinationSize?: number;
}>;

export type MigrationPlan = Readonly<{
  copies: readonly PlannedCopy[];
  /** Source keys already present at the destination with a matching size. */
  skipped: number;
  /** Keys no route matched. A non-empty list must abort the run. */
  unroutable: readonly string[];
  /** Zero-byte source objects. Copied anyway, but surfaced — several avatars are 0 bytes. */
  emptySourceKeys: readonly string[];
  /** Per-prefix totals for the pre-flight summary. */
  byPrefix: readonly PrefixSummary[];
}>;

export type PrefixSummary = Readonly<{
  prefix: string;
  destination: MigrationDestination;
  objects: number;
  bytes: number;
  toCopy: number;
  bytesToCopy: number;
}>;

export type PlanOptions = Readonly<{
  /** Restrict to keys starting with any of these prefixes. Empty = everything. */
  prefixFilters?: readonly string[];
  /** Restrict to a single destination. */
  onlyDestination?: MigrationDestination | null;
  routes?: readonly MigrationRoute[];
}>;

/**
 * True when the key is in scope for a `--prefix` filter. An empty filter list
 * means "everything".
 */
export function matchesPrefixFilter(key: string, filters: readonly string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((filter) => key.startsWith(filter));
}

/**
 * Build the copy plan from one listing of the source and one listing per
 * destination.
 *
 * Deliberately listing-driven rather than HEAD-per-object: 50,901 HEAD requests
 * would cost more than the copy itself, and three listings answer the same
 * question. Size is the only comparison available from a listing, which is
 * enough here because every object is content-addressed by its own upload path
 * (a same-key rewrite with identical bytes is a no-op worth skipping).
 */
export function planMigration(
  sourceObjects: readonly ObjectSummary[],
  destinationObjects: Readonly<Record<MigrationDestination, readonly ObjectSummary[]>>,
  options: PlanOptions = {},
): MigrationPlan {
  const routes = options.routes ?? MIGRATION_ROUTES;
  const prefixFilters = options.prefixFilters ?? [];

  const destinationSizes: Record<MigrationDestination, Map<string, number>> = {
    media: new Map(destinationObjects.media.map((object) => [object.key, object.size])),
    private: new Map(destinationObjects.private.map((object) => [object.key, object.size])),
  };

  const copies: PlannedCopy[] = [];
  const unroutable: string[] = [];
  const emptySourceKeys: string[] = [];
  const prefixTotals = new Map<
    string,
    { destination: MigrationDestination; objects: number; bytes: number; toCopy: number; bytesToCopy: number }
  >();
  let skipped = 0;

  for (const object of sourceObjects) {
    const destination = classifyKey(object.key, routes);
    if (destination === null) {
      unroutable.push(object.key);
      continue;
    }

    // Filters are applied AFTER routing so an unroutable key is still reported
    // even when the run is scoped to one prefix — a surprise key is a surprise
    // key regardless of what this particular invocation was asked to move.
    if (!matchesPrefixFilter(object.key, prefixFilters)) continue;
    if (options.onlyDestination && destination !== options.onlyDestination) continue;

    if (object.size === 0) emptySourceKeys.push(object.key);

    const route = routes.find((candidate) => object.key.startsWith(candidate.prefix))!;
    const totals = prefixTotals.get(route.prefix) ?? {
      destination,
      objects: 0,
      bytes: 0,
      toCopy: 0,
      bytesToCopy: 0,
    };
    totals.objects += 1;
    totals.bytes += object.size;

    const destinationSize = destinationSizes[destination].get(object.key);
    if (destinationSize === undefined) {
      copies.push({ key: object.key, destination, size: object.size, reason: 'missing' });
      totals.toCopy += 1;
      totals.bytesToCopy += object.size;
    } else if (destinationSize !== object.size) {
      copies.push({
        key: object.key,
        destination,
        size: object.size,
        reason: 'size-mismatch',
        destinationSize,
      });
      totals.toCopy += 1;
      totals.bytesToCopy += object.size;
    } else {
      skipped += 1;
    }

    prefixTotals.set(route.prefix, totals);
  }

  const byPrefix: PrefixSummary[] = [...prefixTotals.entries()].map(([prefix, totals]) => ({
    prefix,
    destination: totals.destination,
    objects: totals.objects,
    bytes: totals.bytes,
    toCopy: totals.toCopy,
    bytesToCopy: totals.bytesToCopy,
  }));
  byPrefix.sort((left, right) => right.bytes - left.bytes);

  return { copies, skipped, unroutable, emptySourceKeys, byPrefix };
}

export type VerificationProblem = Readonly<{
  key: string;
  destination: MigrationDestination;
  kind: 'missing' | 'size-mismatch';
  sourceSize: number;
  destinationSize?: number;
}>;

export type VerificationResult = Readonly<{
  checked: number;
  problems: readonly VerificationProblem[];
  unroutable: readonly string[];
}>;

/**
 * Assert that every source key exists at its routed destination with the same
 * byte size. Same listing-driven approach as the plan, for the same reason.
 */
export function verifyMigration(
  sourceObjects: readonly ObjectSummary[],
  destinationObjects: Readonly<Record<MigrationDestination, readonly ObjectSummary[]>>,
  options: PlanOptions = {},
): VerificationResult {
  const routes = options.routes ?? MIGRATION_ROUTES;
  const prefixFilters = options.prefixFilters ?? [];

  const destinationSizes: Record<MigrationDestination, Map<string, number>> = {
    media: new Map(destinationObjects.media.map((object) => [object.key, object.size])),
    private: new Map(destinationObjects.private.map((object) => [object.key, object.size])),
  };

  const problems: VerificationProblem[] = [];
  const unroutable: string[] = [];
  let checked = 0;

  for (const object of sourceObjects) {
    const destination = classifyKey(object.key, routes);
    if (destination === null) {
      unroutable.push(object.key);
      continue;
    }
    if (!matchesPrefixFilter(object.key, prefixFilters)) continue;
    if (options.onlyDestination && destination !== options.onlyDestination) continue;

    checked += 1;
    const destinationSize = destinationSizes[destination].get(object.key);
    if (destinationSize === undefined) {
      problems.push({ key: object.key, destination, kind: 'missing', sourceSize: object.size });
    } else if (destinationSize !== object.size) {
      problems.push({
        key: object.key,
        destination,
        kind: 'size-mismatch',
        sourceSize: object.size,
        destinationSize,
      });
    }
  }

  return { checked, problems, unroutable };
}

/** Errors worth another attempt: throttling, transient 5xx, and transport faults. */
export function isRetryableStorageError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
    $retryable?: { throttling?: boolean };
  };

  if (candidate.$retryable) return true;
  if (candidate.name === 'SlowDown' || candidate.Code === 'SlowDown') return true;
  if (candidate.name === 'RequestTimeout' || candidate.name === 'TimeoutError') return true;

  const status = candidate.$metadata?.httpStatusCode;
  if (status === 429) return true;
  // 501 Not Implemented is permanent, not transient: it is how R2 rejects a
  // header it does not support (notably `x-amz-acl`). Retrying it four times
  // with backoff only makes a code bug fail more slowly.
  if (status === 501) return false;
  if (status !== undefined && status >= 500) return true;

  // Undici / Node transport faults surface with no HTTP status at all.
  const transportCodes = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'];
  return transportCodes.includes(candidate.Code ?? candidate.name ?? '');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}
