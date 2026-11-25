import { createHash, randomUUID } from 'node:crypto';
import { CATALOG_SNAPSHOT_MANIFEST_URL } from '@boardsesh/shared-schema/catalog-access-policy';
import { redisClientManager } from '../redis/client';
import { logger } from './logger';
import { withRedisDeadline } from './redis-rate-limiter';

export type CatalogLane = 'interactive' | 'sync';

export interface CatalogIdentity {
  userId?: string;
  /** Backend-only identity established by a verified first-party server proof. */
  service?: 'www-catalog-cache';
  /** Already normalized and verified by the HTTP/WS transport; never a client claim. */
  trustedClientIp?: string;
}

export interface CatalogBudgetRequest {
  operation: string;
  lane: CatalogLane;
  /** An enforced upper bound. Aggregations should reserve workUnits instead of fictitious rows. */
  requestedRows: number;
  workUnits?: number;
}

/** Serializable, but only a trusted server may return this in a release request. */
export interface CatalogAccessLease {
  id: string;
  expiresAt: number;
  requestedRows: number;
  lane: CatalogLane;
  mode: 'redis' | 'local';
}

type LimitReason = 'work' | 'rows' | 'concurrency' | 'capacity';

export class CatalogRateLimitError extends Error {
  readonly code = 'RATE_LIMITED';
  readonly snapshotManifestUrl = CATALOG_SNAPSHOT_MANIFEST_URL;

  constructor(
    readonly retryAfterSeconds: number,
    readonly reason: LimitReason,
  ) {
    super('Catalog access limit reached. Use the public daily snapshots for bulk downloads.');
    this.name = 'CatalogRateLimitError';
  }
}

/**
 * Row budgets count returned rows after settlement; work budgets count attempts.
 * 180 sync pages/minute at 500 rows permits 5.4m rows/hour before the hourly cap.
 * A cold recovery may consume millions of rows, so sync has its own large budget.
 * Authenticated users share only the generous IP backstop, preserving gym NATs.
 * Limits are shared across operations, filters, HTTP, and WebSocket connections.
 */
export const CATALOG_BUDGET_LIMITS = {
  interactive: { workPerMinute: 180, rowsPerHour: 100_000, rowsPerDay: 500_000, concurrency: 6 },
  anonymousInteractive: { workPerMinute: 600, rowsPerHour: 30_000, rowsPerDay: 100_000, concurrency: 16 },
  serverCache: { workPerMinute: 3000, rowsPerHour: 2_000_000, rowsPerDay: 20_000_000, concurrency: 8 },
  sync: { workPerMinute: 180, rowsPerHour: 5_000_000, rowsPerDay: 30_000_000, concurrency: 2 },
  authenticatedIpMultiplier: 20,
  authenticatedIpConcurrency: 48,
  identityConcurrency: 8,
  anonymousIdentityConcurrency: 16,
  globalConcurrency: 32,
  syncGlobalConcurrency: 8,
  fallbackConcurrency: 8,
  leaseTtlMs: 120_000,
  maxLocalBuckets: 50_000,
  // REST reserve/release can land on different replicas; retain bounded shadows
  // for up to 120s without making that cache tighter than the actual policy.
  maxLocalLeases: 8192,
} as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// All script keys share a Redis Cluster slot, including keys read from lease metadata.
const PREFIX = 'catalog-budget:{catalog-budget}:';

interface CounterSpec {
  key: string;
  limit: number;
  amount: number;
  expiresAt: number;
  reason: 'work' | 'rows';
}

interface ConcurrencySpec {
  key: string;
  limit: number;
}

interface LocalCounter {
  count: number;
  expiresAt: number;
  /** Prevent a delayed release reply from refunding a newer Redis observation twice. */
  redisRevision: number;
  /** Ignore reductions from admission replies that arrive out of request order. */
  redisSequence: number;
  /** Net outage charges still need an acknowledged Redis floor. */
  needsFloor: boolean;
  /** Net local charges since creation, used to reconcile overlapping Redis replies. */
  fallbackCharges: number;
}

interface LocalLease {
  lease: CatalogAccessLease;
  counters: CounterSpec[];
  concurrency: ConcurrencySpec[];
}

interface RedisReply {
  allowed: boolean;
  counts: number[];
  reason?: LimitReason;
  retryAfterSeconds?: number;
}

/** Small injectable seam: tests can exercise distinct backend instances against one Redis. */
export interface CatalogBudgetRedis {
  eval(script: string, numberOfKeys: number, ...arguments_: (string | number)[]): Promise<unknown>;
}

export interface CatalogBudgetDependencies {
  now?: () => number;
  redis?: () => CatalogBudgetRedis | null;
}

/**
 * Floors, all counter checks, and all concurrency leases are one atomic operation.
 * No row/work charge happens on rejection. Expired leases are reaped per scope.
 * Redis stores the authoritative refund keys and amount; release callers supply only an id.
 */
const RESERVE_SCRIPT = `
local request = cjson.decode(ARGV[1])
local counts = {}
local reason = nil
local retry = 1
for index, counter in ipairs(request.counters) do
  local key = KEYS[index + 1]
  local previous = tonumber(redis.call('GET', key) or '0')
  local count = math.max(previous, counter.floor)
  counts[index] = count
  if count > previous then
    redis.call('SET', key, count, 'PX', math.max(1, counter.expiresAt - request.now))
  end
  if count + counter.amount > counter.limit then
    local reset = math.max(1, math.ceil((counter.expiresAt - request.now) / 1000))
    if not reason or reset > retry then
      reason = counter.reason
      retry = reset
    end
  end
end
local concurrencyOffset = #request.counters + 1
for index, scope in ipairs(request.concurrency) do
  local key = KEYS[concurrencyOffset + index]
  redis.call('ZREMRANGEBYSCORE', key, '-inf', request.now)
  if redis.call('ZCARD', key) >= scope.limit and not reason then
    reason = 'concurrency'
    -- Ordinary reads release promptly; the 120s lease is only crash recovery.
    retry = 1
  end
end
if reason then
  return cjson.encode({allowed = false, counts = counts, reason = reason, retryAfterSeconds = retry})
end
local rowKeys = {}
for index, counter in ipairs(request.counters) do
  local key = KEYS[index + 1]
  counts[index] = counts[index] + counter.amount
  redis.call('SET', key, counts[index], 'PX', math.max(1, counter.expiresAt - request.now))
  if counter.reason == 'rows' then table.insert(rowKeys, key) end
end
local concurrencyKeys = {}
for index, scope in ipairs(request.concurrency) do
  local key = KEYS[concurrencyOffset + index]
  redis.call('ZADD', key, request.expiresAt, request.id)
  redis.call('PEXPIRE', key, request.expiresAt - request.now)
  table.insert(concurrencyKeys, key)
end
redis.call('SET', KEYS[1], cjson.encode({
  id = request.id,
  expiresAt = request.expiresAt,
  requestedRows = request.requestedRows,
  rowKeys = rowKeys,
  concurrencyKeys = concurrencyKeys
}), 'PX', request.expiresAt - request.now)
return cjson.encode({allowed = true, counts = counts})
`;

const RELEASE_SCRIPT = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 0 end
local lease = cjson.decode(encoded)
redis.call('DEL', KEYS[1])
if lease.expiresAt <= tonumber(ARGV[1]) then return 0 end
for _, key in ipairs(lease.concurrencyKeys) do
  redis.call('ZREM', key, lease.id)
end
local actualRows = tonumber(ARGV[2])
if actualRows >= 0 then
  local refund = math.max(0, lease.requestedRows - actualRows)
  for _, key in ipairs(lease.rowKeys) do
    local count = redis.call('GET', key)
    if count then
      redis.call('SET', key, math.max(0, tonumber(count) - refund), 'KEEPTTL')
    end
  end
end
return 1
`;

function digest(identity: string): string {
  return createHash('sha256').update(identity).digest('hex');
}

function budgetSpecs(identity: CatalogIdentity, request: CatalogBudgetRequest, now: number) {
  const authenticated = Boolean(identity.userId);
  const service = !authenticated && identity.service === 'www-catalog-cache';
  const primary = digest(
    authenticated
      ? `user:${identity.userId}`
      : service
        ? 'service:www-catalog-cache'
        : `ip:${identity.trustedClientIp || 'unknown'}`,
  );
  const ip = digest(`ip:${identity.trustedClientIp || 'unknown'}`);
  const limits = service
    ? CATALOG_BUDGET_LIMITS.serverCache
    : request.lane === 'sync'
      ? CATALOG_BUDGET_LIMITS.sync
      : authenticated
        ? CATALOG_BUDGET_LIMITS.interactive
        : CATALOG_BUDGET_LIMITS.anonymousInteractive;
  const counters: CounterSpec[] = [];
  const addCounters = (scope: string, multiplier: number) => {
    for (const [windowMs, limit, amount, reason] of [
      [MINUTE, limits.workPerMinute, request.workUnits ?? 1, 'work'],
      [HOUR, limits.rowsPerHour, request.requestedRows, 'rows'],
      [DAY, limits.rowsPerDay, request.requestedRows, 'rows'],
    ] as const) {
      counters.push({
        key: `${PREFIX}${request.lane}:${scope}:${windowMs}:${Math.floor(now / windowMs)}`,
        limit: limit * multiplier,
        amount,
        reason,
        expiresAt: (Math.floor(now / windowMs) + 1) * windowMs,
      });
    }
  };
  addCounters(`identity:${primary}`, 1);
  const concurrency: ConcurrencySpec[] = [
    {
      key: `${PREFIX}active:identity:${primary}`,
      limit:
        !authenticated && !service
          ? CATALOG_BUDGET_LIMITS.anonymousIdentityConcurrency
          : CATALOG_BUDGET_LIMITS.identityConcurrency,
    },
    { key: `${PREFIX}active:${request.lane}:${primary}`, limit: limits.concurrency },
    { key: `${PREFIX}active:global`, limit: CATALOG_BUDGET_LIMITS.globalConcurrency },
  ];
  if (authenticated) {
    addCounters(`ip:${ip}`, CATALOG_BUDGET_LIMITS.authenticatedIpMultiplier);
    concurrency.push({ key: `${PREFIX}active:ip:${ip}`, limit: CATALOG_BUDGET_LIMITS.authenticatedIpConcurrency });
  }
  if (request.lane === 'sync') {
    concurrency.push({ key: `${PREFIX}active:sync:global`, limit: CATALOG_BUDGET_LIMITS.syncGlobalConcurrency });
  }
  return { counters, concurrency };
}

function parseReply(reply: unknown, counterCount: number): RedisReply {
  if (typeof reply !== 'string') throw new Error('Invalid catalog budget Redis reply');
  const parsed: unknown = JSON.parse(reply);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid catalog budget Redis reply');
  const candidate = parsed as Partial<RedisReply>;
  if (
    typeof candidate.allowed !== 'boolean' ||
    !Array.isArray(candidate.counts) ||
    candidate.counts.length !== counterCount ||
    candidate.counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    (!candidate.allowed &&
      (!['work', 'rows', 'concurrency'].includes(candidate.reason ?? '') ||
        !Number.isSafeInteger(candidate.retryAfterSeconds) ||
        (candidate.retryAfterSeconds ?? 0) < 1))
  ) {
    throw new Error('Invalid catalog budget Redis reply');
  }
  return candidate as RedisReply;
}

function validateRequest(request: CatalogBudgetRequest): void {
  if (
    !request.operation ||
    request.operation.length > 128 ||
    !['interactive', 'sync'].includes(request.lane) ||
    !Number.isSafeInteger(request.requestedRows) ||
    request.requestedRows < 0 ||
    !Number.isSafeInteger(request.workUnits ?? 1) ||
    (request.workUnits ?? 1) < 1
  ) {
    throw new RangeError('Invalid catalog budget request');
  }
}

/**
 * Redis is authoritative when available. Local counters shadow its observations;
 * outage charges become floors on recovery, so toggling Redis cannot reset a budget.
 * During an outage this is a per-process bound, not a claim of global coordination.
 * Active outage leases reduce this process's Redis allowance after recovery until
 * they finish/expire; other processes cannot discover them retroactively.
 * A release received by another process can leave a conservative local shadow until
 * the window/lease expires. Healthy Redis admissions do not enforce those shadows.
 */
export function createCatalogBudgetLimiter(dependencies: CatalogBudgetDependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const redis =
    dependencies.redis ??
    (() => (redisClientManager.isRedisConnected() ? redisClientManager.getClients().publisher : null));
  const counters = new Map<string, LocalCounter>();
  const leases = new Map<string, LocalLease>();
  const pendingAdmissions = new Map<string, LocalLease>();
  let nextRedisSequence = 0;
  let lastPrune = 0;
  let lastWarning = 0;

  function warnUnavailable(timestamp: number): void {
    if (timestamp - lastWarning < MINUTE) return;
    lastWarning = timestamp;
    logger.warn('[CatalogBudget] Redis unavailable; bounded local catalog budgets remain active.');
  }

  function prune(timestamp: number, force = false): void {
    for (const [id, entry] of leases) {
      if (entry.lease.expiresAt <= timestamp) leases.delete(id);
    }
    if (!force && timestamp - lastPrune < MINUTE && counters.size < CATALOG_BUDGET_LIMITS.maxLocalBuckets) return;
    for (const [key, counter] of counters) {
      if (counter.expiresAt <= timestamp) counters.delete(key);
    }
    lastPrune = timestamp;
  }

  function observe(specs: CounterSpec[], reply: RedisReply, fallbackAtStart: number[], sequence: number): void {
    for (const [index, spec] of specs.entries()) {
      const existing = counters.get(spec.key);
      const concurrentFallback = Math.max(0, (existing?.fallbackCharges ?? 0) - fallbackAtStart[index]);
      const observed = reply.counts[index] + concurrentFallback;
      counters.set(spec.key, {
        // Retain a conservative observation while transferring local outage charges.
        // The script acknowledges its floor even on refusal. Once no concurrent
        // fallback changed that net charge, later Redis observations must be allowed
        // to include refunds made by another instance instead of restoring them.
        count:
          existing && (existing.needsFloor || sequence < existing.redisSequence)
            ? Math.max(existing.count, observed)
            : observed,
        expiresAt: spec.expiresAt,
        redisRevision: (existing?.redisRevision ?? 0) + 1,
        redisSequence: Math.max(existing?.redisSequence ?? 0, sequence),
        needsFloor: Boolean(existing?.needsFloor && existing.fallbackCharges !== fallbackAtStart[index]),
        fallbackCharges: existing?.fallbackCharges ?? 0,
      });
    }
  }

  function reserveLocal(entry: LocalLease, timestamp: number): CatalogAccessLease {
    let quotaFailure: CatalogRateLimitError | undefined;
    for (const spec of entry.counters) {
      if ((counters.get(spec.key)?.count ?? 0) + spec.amount > spec.limit) {
        const resetSeconds = Math.max(1, Math.ceil((spec.expiresAt - timestamp) / 1000));
        if (!quotaFailure || resetSeconds > quotaFailure.retryAfterSeconds) {
          quotaFailure = new CatalogRateLimitError(resetSeconds, spec.reason);
        }
      }
    }
    if (quotaFailure) throw quotaFailure;
    const pendingOthers = pendingAdmissions.size - (pendingAdmissions.has(entry.lease.id) ? 1 : 0);
    if (leases.size + pendingOthers >= CATALOG_BUDGET_LIMITS.fallbackConcurrency) {
      throw new CatalogRateLimitError(1, 'concurrency');
    }
    for (const scope of entry.concurrency) {
      let active = 0;
      for (const current of leases.values()) {
        if (current.concurrency.some((candidate) => candidate.key === scope.key)) active++;
      }
      for (const current of pendingAdmissions.values()) {
        if (
          current.lease.id !== entry.lease.id &&
          current.concurrency.some((candidate) => candidate.key === scope.key)
        ) {
          active++;
        }
      }
      if (active >= scope.limit) throw new CatalogRateLimitError(1, 'concurrency');
    }
    for (const spec of entry.counters) {
      const previous = counters.get(spec.key);
      counters.set(spec.key, {
        count: (previous?.count ?? 0) + spec.amount,
        expiresAt: spec.expiresAt,
        redisRevision: previous?.redisRevision ?? 0,
        redisSequence: previous?.redisSequence ?? 0,
        needsFloor: (previous?.needsFloor ?? false) || spec.amount > 0,
        fallbackCharges: (previous?.fallbackCharges ?? 0) + spec.amount,
      });
    }
    entry.lease.mode = 'local';
    leases.set(entry.lease.id, entry);
    return { ...entry.lease };
  }

  async function reserveCatalogAccess(
    identity: CatalogIdentity,
    request: CatalogBudgetRequest,
  ): Promise<CatalogAccessLease> {
    validateRequest(request);
    const timestamp = now();
    prune(timestamp);
    const specs = budgetSpecs(identity, request, timestamp);
    let missingCounters = specs.counters.filter((spec) => !counters.has(spec.key)).length;
    if (counters.size + missingCounters > CATALOG_BUDGET_LIMITS.maxLocalBuckets) {
      // A minute/hour boundary can expire slots before the periodic sweep is due.
      prune(timestamp, true);
      missingCounters = specs.counters.filter((spec) => !counters.has(spec.key)).length;
    }
    if (
      counters.size + missingCounters > CATALOG_BUDGET_LIMITS.maxLocalBuckets ||
      leases.size + pendingAdmissions.size >= CATALOG_BUDGET_LIMITS.maxLocalLeases
    ) {
      throw new CatalogRateLimitError(60, 'capacity');
    }
    // Claim the bounded map slots synchronously, before a Redis await can overlap.
    for (const spec of specs.counters) {
      if (!counters.has(spec.key)) {
        counters.set(spec.key, {
          count: 0,
          expiresAt: spec.expiresAt,
          redisRevision: 0,
          redisSequence: 0,
          needsFloor: false,
          fallbackCharges: 0,
        });
      }
    }
    const lease: CatalogAccessLease = {
      id: randomUUID(),
      expiresAt: timestamp + CATALOG_BUDGET_LIMITS.leaseTtlMs,
      requestedRows: request.requestedRows,
      lane: request.lane,
      mode: 'redis',
    };
    const entry: LocalLease = { lease, ...specs };
    let publisher: CatalogBudgetRedis | null;
    try {
      publisher = redis();
    } catch {
      // Redis can disconnect between the manager's connectivity and client lookups.
      warnUnavailable(timestamp);
      publisher = null;
    }
    if (!publisher) return reserveLocal(entry, timestamp);
    const fallbackAtStart = specs.counters.map((spec) => counters.get(spec.key)?.fallbackCharges ?? 0);
    const sequence = ++nextRedisSequence;
    pendingAdmissions.set(lease.id, entry);
    try {
      const concurrency = specs.concurrency.map((scope) => {
        let localActive = 0;
        for (const current of leases.values()) {
          if (current.lease.mode === 'local' && current.concurrency.some((candidate) => candidate.key === scope.key)) {
            localActive++;
          }
        }
        const limit = scope.limit - localActive;
        if (limit <= 0) throw new CatalogRateLimitError(1, 'concurrency');
        return { ...scope, limit };
      });
      const keys = [
        `${PREFIX}lease:${lease.id}`,
        ...specs.counters.map((spec) => spec.key),
        ...specs.concurrency.map((scope) => scope.key),
      ];
      const reply = parseReply(
        await withRedisDeadline(
          publisher.eval(
            RESERVE_SCRIPT,
            keys.length,
            ...keys,
            JSON.stringify({
              now: timestamp,
              id: lease.id,
              expiresAt: lease.expiresAt,
              requestedRows: request.requestedRows,
              counters: specs.counters.map((spec) => ({
                ...spec,
                floor: counters.get(spec.key)?.needsFloor ? counters.get(spec.key)?.count : 0,
              })),
              concurrency,
            }),
          ),
        ),
        specs.counters.length,
      );
      observe(specs.counters, reply, fallbackAtStart, sequence);
      if (!reply.allowed) throw new CatalogRateLimitError(reply.retryAfterSeconds ?? 1, reply.reason ?? 'capacity');
      leases.set(lease.id, entry);
      return { ...lease };
    } catch (error) {
      if (error instanceof CatalogRateLimitError) throw error;
      warnUnavailable(timestamp);
      // The timed-out script may still execute. The same id lets release remove it.
      return reserveLocal(entry, timestamp);
    } finally {
      pendingAdmissions.delete(lease.id);
    }
  }

  async function releaseCatalogAccess(lease: CatalogAccessLease, actualRows?: number): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(lease.id)) return;
    const timestamp = now();
    const local = leases.get(lease.id);
    const revisions = new Map(local?.counters.map((spec) => [spec.key, counters.get(spec.key)?.redisRevision]));
    // Delete before awaiting Redis, so two concurrent releases cannot refund locally twice.
    leases.delete(lease.id);
    const returnedRows =
      actualRows !== undefined && Number.isSafeInteger(actualRows) && actualRows >= 0 ? actualRows : -1;
    let redisReleased = false;
    try {
      const publisher = redis();
      if (publisher) {
        redisReleased =
          (await withRedisDeadline(
            publisher.eval(RELEASE_SCRIPT, 1, `${PREFIX}lease:${lease.id}`, timestamp, returnedRows),
          )) === 1;
      }
    } catch {
      warnUnavailable(timestamp);
    }
    if (
      !local ||
      local.lease.expiresAt <= timestamp ||
      returnedRows < 0 ||
      (local.lease.mode !== 'local' && !redisReleased)
    ) {
      return;
    }
    const refund = Math.max(0, local.lease.requestedRows - returnedRows);
    for (const spec of local.counters) {
      if (spec.reason !== 'rows' || spec.expiresAt <= timestamp) continue;
      const counter = counters.get(spec.key);
      if (!counter) continue;
      // A later observation may already include this refund. Keeping a conservative
      // shadow is safer than subtracting the same rows again after a delayed reply.
      if (counter.redisRevision !== revisions.get(spec.key)) continue;
      counter.count = Math.max(0, counter.count - refund);
      // Account for refunds concurrent with an outstanding Redis admission.
      if (local.lease.mode === 'local') counter.fallbackCharges -= refund;
    }
  }

  async function runCatalogQuery<Result>(
    identity: CatalogIdentity,
    request: CatalogBudgetRequest,
    work: () => Promise<Result>,
    countRows?: (result: Result) => number,
  ): Promise<Result> {
    const lease = await reserveCatalogAccess(identity, request);
    let returnedRows = 0;
    try {
      const result = await work();
      returnedRows = countRows ? countRows(result) : Array.isArray(result) ? result.length : request.requestedRows;
      return result;
    } finally {
      // Work remains charged even when the query fails; its unused row reservation does not.
      await releaseCatalogAccess(lease, returnedRows);
    }
  }

  return { reserveCatalogAccess, releaseCatalogAccess, runCatalogQuery };
}

const catalogBudget = createCatalogBudgetLimiter();
export const reserveCatalogAccess = catalogBudget.reserveCatalogAccess;
export const releaseCatalogAccess = catalogBudget.releaseCatalogAccess;
export const runCatalogQuery = catalogBudget.runCatalogQuery;
