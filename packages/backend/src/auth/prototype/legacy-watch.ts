import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import * as schema from '@boardsesh/db/auth-prototype';
import type { PrototypeDatabase } from './authority';
import { createPrototypeNativeFacade } from './identity-native-facade';
import { PROTOTYPE_WATCH_CODE_TTL_SECONDS, PrototypeWatchPairingError } from './identity-watch-facade';
import { ensurePrototypeMigrationEpoch } from './migration-epoch';
import { hasPrototypeLegacySourceDenial } from './legacy-source-state';

const LEGACY_WINDOW_MS = PROTOTYPE_WATCH_CODE_TTL_SECONDS * 1000;
const EPOCH_NAME = 'legacy-watch';
// Both commands execute without another Redis client changing the key between
// them. GETDEL is the released single-use primitive; no expiry is renewed.
const CONSUME_PENDING_CODE = `
local remaining = redis.call('PTTL', KEYS[1])
local user = redis.call('GETDEL', KEYS[1])
return { user or false, remaining }
`;

type PairingRedis = Pick<Redis, 'status'> & {
  eval: (script: string, keyCount: number, key: string) => Promise<unknown>;
};

interface FailureHooks {
  readonly afterConsume?: () => Promise<void>;
  readonly afterMutation?: () => Promise<void>;
}

/**
 * Disposable compatibility proof for already-pending raw user-ID Redis values.
 * Trusted migration setup supplies the fixed cutover and isolated namespace;
 * neither comes from a pairing request. No product router mounts this facade.
 */
export function createPrototypeLegacyWatchFacade(
  database: PrototypeDatabase,
  nativeSigningKey: Uint8Array,
  redis: PairingRedis,
  namespace: string,
  cutoverAt: Date,
  hooks: FailureHooks = {},
) {
  if (!/^boardsesh:ba01:legacy-watch:[a-zA-Z0-9:-]+:$/.test(namespace))
    throw new Error('Legacy watch proof requires an explicit isolated BA-01 Redis namespace');
  // Copy the instant before any await. Mutating caller-owned Date objects must
  // never move an already configured migration horizon.
  const cutoverTime = cutoverAt.getTime();
  if (!Number.isSafeInteger(cutoverTime) || cutoverTime > Date.now()) throw new PrototypeWatchPairingError(401);
  const native = createPrototypeNativeFacade(database, nativeSigningKey);

  async function consumePairingCode(code: unknown) {
    if (typeof code !== 'string' || !code) throw new PrototypeWatchPairingError(400);
    const normalized = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (normalized.length !== 8) throw new PrototypeWatchPairingError(400);

    // Commit this permanent epoch before any destructive Redis operation. A
    // later failed mint/rollback must not authorize another caller's cutover.
    await native.withIssuanceTransaction(async (transaction) => {
      if (!(await ensurePrototypeMigrationEpoch(transaction, EPOCH_NAME, cutoverTime)))
        throw new PrototypeWatchPairingError(401);
    });
    if (Date.now() >= cutoverTime + LEGACY_WINDOW_MS) throw new PrototypeWatchPairingError(401);
    if (redis.status !== 'ready') throw new PrototypeWatchPairingError(503);
    const observedAt = Date.now();
    let consumed: unknown;
    try {
      consumed = await redis.eval(CONSUME_PENDING_CODE, 1, `${namespace}${normalized}`);
    } catch {
      // A lost Redis response might already have consumed the code. Retrying
      // cannot safely restore it or fall back to process-local acceptance.
      throw new PrototypeWatchPairingError(503);
    }
    if (
      !Array.isArray(consumed) ||
      consumed.length !== 2 ||
      typeof consumed[0] !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(consumed[0]) ||
      typeof consumed[1] !== 'number' ||
      !Number.isInteger(consumed[1]) ||
      consumed[1] <= 0 ||
      consumed[1] > LEGACY_WINDOW_MS
    )
      throw new PrototypeWatchPairingError(401);
    const [userId, remainingMilliseconds] = consumed as [string, number];
    // Starting before the Redis request is conservatively earlier than its
    // PTTL observation, avoiding an extra network-latency validity extension.
    const originalExpiresAt = Math.min(observedAt + remainingMilliseconds, cutoverTime + LEGACY_WINDOW_MS);
    await hooks.afterConsume?.();
    return native.withIssuanceTransaction(async (transaction, issueForSession) => {
      const now = Date.now();
      if (now >= originalExpiresAt || !(await ensurePrototypeMigrationEpoch(transaction, EPOCH_NAME, cutoverTime)))
        throw new PrototypeWatchPairingError(401);
      const [user] = await transaction.select().from(schema.user).where(eq(schema.user.id, userId));
      const [cutoff] = await transaction
        .select()
        .from(schema.prototypeUserCutoff)
        .where(eq(schema.prototypeUserCutoff.userId, userId));
      if (!user || cutoff || (await hasPrototypeLegacySourceDenial(transaction, userId)))
        throw new PrototypeWatchPairingError(401);
      const lineageId = `credential:legacy-watch:${createHash('sha256')
        .update(JSON.stringify([namespace, normalized, cutoverTime]))
        .digest('hex')}`;
      const [previous] = await transaction
        .select()
        .from(schema.prototypeLegacyLineage)
        .where(eq(schema.prototypeLegacyLineage.id, lineageId));
      if (previous) throw new PrototypeWatchPairingError(401);
      const sessionId = randomUUID();
      await transaction.insert(schema.session).values({
        id: sessionId,
        userId,
        token: randomBytes(32).toString('hex'),
        createdAt: new Date(0),
        updatedAt: new Date(now),
        expiresAt: new Date(originalExpiresAt),
        originalAuthenticatedAt: null,
        legacyLineageId: lineageId,
      });
      await transaction.insert(schema.prototypeLegacyLineage).values({
        id: lineageId,
        userId,
        sessionId,
        originalAuthenticatedAt: null,
        originalExpiresAt: new Date(originalExpiresAt),
      });
      const pair = await issueForSession(userId, sessionId);
      await hooks.afterMutation?.();
      return pair;
    });
  }

  return { consumePairingCode };
}
