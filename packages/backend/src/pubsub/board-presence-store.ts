import type { Logger } from 'winston';
import { z } from 'zod';
import type { BoardLayersSnapshot, BoardPresenceClimb } from '@boardsesh/shared-schema';
import { redisClientManager } from '../redis/client';
import { BoardLayersSnapshotRedisSchema, BoardPresenceClimbRedisSchema } from '../validation/schemas/board-presence';

/** Result of the Stage-A report gate read (one pipeline, see `getBoardReportGate`). */
export type BoardReportGate = {
  /** Whether `emitterId` currently has a live proof-of-presence stamp on the board. */
  isMember: boolean;
  /** First-seen epoch-ms for the durable-history dwell gate, or null when unknown/implausible. */
  firstSeenMs: number | null;
  /** Value of `board:{id}:lastReport` ("emitterId|climbUuid|angle"), or null when never set / expired. */
  lastReport: string | null;
  /**
   * The board's current connection holder (`board:{id}:writer`), or null when
   * free / unknown. The dedup short-circuit must only fire while the retrying
   * emitter still holds the wall — a WS-close backstop clear between the
   * original send and the retry deletes the writer key but leaves lastReport,
   * and short-circuiting then would strand the wall looking free while the
   * emitter holds it (no re-take, no re-broadcast).
   */
  currentWriter: string | null;
};

export type CommitBoardClimbInput = {
  boardId: string;
  emitterId: string;
  climb: BoardPresenceClimb;
  climbUuid: string;
  effectiveAngle: number;
  /** The reporting connection's party-session id, when it's in one. */
  sessionId: string | null;
};

export type CommitBoardClimbResult = {
  /** The writer key's previous value (from the atomic SET..GET), or null when
   * the board was free / the commit failed. */
  previousWriter: string | null;
  /**
   * True only when the writer SET..GET slot actually executed without error —
   * i.e. `previousWriter` is a real observation, not a failure collapsed to
   * null. The caller must gate the hand-off broadcast on this: a failing
   * pipeline otherwise looks like "board was free" (`null !== emitterId`) and
   * would spuriously broadcast a hand-off + kick a Live Activity push on
   * every send while Redis is unhealthy.
   */
  writerSlotOk: boolean;
  /**
   * True when this commit VERIFIABLY created or changed the board's reverse
   * session binding (`board:{id}:session`) — i.e. the wall was previously
   * unbound, or bound to a different session. False for a re-stamp of the
   * same session, a session-less report, or when the binding slot didn't
   * verifiably execute. `reportBoardClimb` uses it to seed the board-queue
   * preview exactly when a session first takes (or takes over) the wall —
   * the preview's live producer only fires on queue events, so without this
   * seed a kiosk subscribed before the first send would stay blank until the
   * next queue mutation.
   */
  sessionBindingChanged: boolean;
};

export type BoardWriterTakeResult = Pick<CommitBoardClimbResult, 'previousWriter' | 'writerSlotOk'>;

export type BoardLayersStaleResult = {
  snapshot: BoardLayersSnapshot;
  changed: boolean;
};

export type CommitBoardLayersResult = {
  snapshot: BoardLayersSnapshot;
  accepted: boolean;
  previousWriter: string | null;
  previousClaimToken: string | null;
};

const CommitBoardLayersResultRedisSchema: z.ZodType<CommitBoardLayersResult> = z.object({
  snapshot: BoardLayersSnapshotRedisSchema,
  accepted: z.boolean(),
  previousWriter: z.string().nullable(),
  previousClaimToken: z.string().nullable(),
});

function parseBoardLayersSnapshot(raw: string, expectedBoardId: string): BoardLayersSnapshot {
  const snapshot = BoardLayersSnapshotRedisSchema.parse(JSON.parse(raw));
  if (String(snapshot.boardId) !== expectedBoardId) {
    throw new Error(`Quantum layer snapshot board ${snapshot.boardId} does not match Redis key ${expectedBoardId}`);
  }
  return snapshot;
}

type LocalBoardLayersRecord = {
  snapshot: BoardLayersSnapshot;
  ownerToken: string;
  expiresAtMs: number;
};

type LocalBoardWriterRecord = {
  emitterId: string;
  layerClaimToken?: string;
  expiresAtMs: number;
};

// Board-presence durable history (Redis FIFO) configuration. The live
// "now on the wall" feed is ephemeral; this buffer backfills late joiners
// before the `boardNowPlaying` subscription takes over.
const BOARD_HISTORY_SIZE = 50; // Keep the last 50 climbs per board
const BOARD_HISTORY_TTL = 604_800; // 1 week
// The per-board seq counter's TTL matches BOARD_HISTORY_TTL so the common
// case (an active board) never sees the counter expire while the Redis
// history buffer is still populated. But `board_climb_events` rows are
// durable forever, so a board dormant for *longer* than a week still has a
// live durable floor after this key expires — INCR would otherwise restart
// at 1 and collide with / precede rows that still exist in Postgres. That
// residual gap is closed by the dormancy reseed in `nextBoardSeq` (see
// `boardSeqFloorProvider` / `allocateBoardSeqAtLeast` below), not by this TTL
// alone.
const BOARD_SEQ_TTL = 604_800; // 1 week
// Once INCR returns a value at or below this, nextBoardSeq consults the
// durable floor provider — a small INCR result is the signature of a
// freshly-(re)created Redis key, which happens both for a genuinely new board
// and for a dormant board whose key just expired.
const BOARD_SEQ_RESEED_THRESHOLD = 50;
// Proof-of-presence window: how long after connecting (resolveBoardForSerial /
// resolveBoardForConfig) a user may report climbs to that board's feed. Long
// enough for a climbing session; a reconnect re-stamps it.
const BOARD_MEMBERSHIP_TTL = 43_200; // 12 hours
// Phones report the confirmed Quantum roster every 10 seconds while active.
// Three missed reports make the snapshot stale; Redis retention is then capped
// by the controller's longest remaining timer plus this grace period.
const BOARD_LAYERS_HEARTBEAT_GRACE_SECONDS = 30;
// Write-side idempotency window for reportBoardClimb: a retry of the exact
// same (emitter, climb, angle) within this window is treated as a no-op
// duplicate rather than a new send (see `getBoardReportGate` / A2 dedup).
const REPORT_DEDUP_WINDOW_MS = 10_000;
// Epoch-ms floor a first-seen stamp must clear to be trusted. Guards against
// legacy sentinel values (e.g. an old '1') that would otherwise trivially
// satisfy the durable-history dwell gate.
const PLAUSIBLE_EPOCH_MS_FLOOR = 1_600_000_000_000;

function parsePlausibleFirstSeenMs(raw: string | null): number | null {
  if (raw === null) return null;
  const firstSeen = Number(raw);
  if (!Number.isFinite(firstSeen) || firstSeen < PLAUSIBLE_EPOCH_MS_FLOOR) return null;
  return firstSeen;
}

function boardLayersTtlSeconds(snapshot: BoardLayersSnapshot): number {
  const longestRemainingSeconds = snapshot.layers.reduce(
    (longest, layer) => Math.max(longest, layer.remainingSeconds),
    0,
  );
  return Math.max(1, longestRemainingSeconds + BOARD_LAYERS_HEARTBEAT_GRACE_SECONDS);
}

function ageBoardLayersSnapshot(snapshot: BoardLayersSnapshot, nowMs = Date.now()): BoardLayersSnapshot {
  const observedAtMs = Date.parse(snapshot.observedAt);
  const elapsedSeconds = Number.isFinite(observedAtMs) ? Math.max(0, Math.floor((nowMs - observedAtMs) / 1000)) : 0;
  const layers = snapshot.layers.flatMap((layer) => {
    const remainingSeconds = Math.max(0, layer.remainingSeconds - elapsedSeconds);
    return remainingSeconds > 0 ? [{ ...layer, remainingSeconds }] : [];
  });
  const stale =
    snapshot.stale || (Number.isFinite(observedAtMs) && elapsedSeconds >= BOARD_LAYERS_HEARTBEAT_GRACE_SECONDS);
  if (layers.length === snapshot.layers.length && !stale && elapsedSeconds === 0) return snapshot;
  return { ...snapshot, layers, stale };
}

/**
 * Minimal logger surface the store needs (`commitBoardClimb` downgrades
 * per-command pipeline failures to warnings).
 */
export type BoardPresenceStoreLogger = Pick<Logger, 'error' | 'warn'>;

export type BoardPresenceStoreDeps = {
  /**
   * Whether Redis is currently connected and available (mirrors
   * `PubSub.isRedisConnected()`, which already folds in "adapter exists").
   */
  isRedisAvailable: () => boolean;
  /** Whether Redis is required (REDIS_URL configured) — gates fail-closed rethrow. */
  isRedisRequired: () => boolean;
  logger: BoardPresenceStoreLogger;
};

export type BoardSeqAllocator = (boardId: number, candidate: number) => Promise<number>;

/**
 * Board-presence Redis KV helpers, extracted out of `PubSub` so the pub/sub
 * fan-out class (`PubSubChannel`-backed) doesn't also carry these
 * board-connection bookkeeping concerns. `PubSub` still re-exposes every
 * method unchanged — this is a pure code-location move, not an API change.
 *
 * Every method here degrades gracefully without Redis: local-only mode either
 * falls back to an in-memory map (seq counter, proof-of-presence) or simply
 * returns "unknown"/empty (durable history, writer holder, session→board),
 * matching the single-instance-only guarantees these features already had.
 */
export class BoardPresenceStore {
  // Local candidate/fallback for the per-board monotonic seq counter. In the
  // running server PostgreSQL is authoritative; Redis (or this map without
  // Redis) supplies the candidate passed to that allocator.
  private localBoardSeq = new Map<string, number>();
  // Per-board watermark for the seq dormancy reseed (see
  // `ensureBoardSeqClearOfDurableFloor`): the highest seq this instance has
  // verified clear of the durable floor or allocated through the reseed
  // check. Lets a brand-new board skip the repeated MAX(seq) Postgres lookup
  // on each of its first ~BOARD_SEQ_RESEED_THRESHOLD sends. One number per
  // board that allocates during the process lifetime (bounded like
  // `localBoardSeq`); never TTL'd — see the safety analysis on the method.
  private boardSeqVerifiedThrough = new Map<string, number>();
  // Sticky "the floor consultation FAILED and hasn't succeeded since" marker.
  // While a board is in here, every nextBoardSeq call retries the floor
  // consultation — regardless of the INCR value and bypassing the watermark
  // skip — so a transient Postgres/Lua failure during the reseed window can't
  // let the counter grow past BOARD_SEQ_RESEED_THRESHOLD while still below
  // the durable floor (which would permanently freeze clients holding
  // pre-reset high seqs). Cleared only by a successful verification/reseed.
  // Same lifecycle/bounds as the watermark map.
  private boardSeqReseedPending = new Set<string>();
  // Local-only proof-of-presence: `${boardId}:${userId}` → expiry epoch ms.
  private localBoardMembership = new Map<string, number>();
  // Local-only session↔board binding fallback (single-instance, no Redis) —
  // mirrors the localBoardSeq / localBoardMembership pattern. In Redis mode
  // the authoritative pair is `session:{id}:board` / `board:{id}:session`
  // written by `commitBoardClimb`; these maps only serve Redis-less
  // deployments so the board-queue-preview producer still resolves bindings.
  // Expiry matches BOARD_MEMBERSHIP_TTL; entries are lazily evicted on read
  // and overwritten on each commit (bounded by the number of boards/sessions
  // active in one process lifetime, like the other local maps).
  private localSessionBoard = new Map<string, { value: string; expiresAtMs: number }>();
  private localBoardSession = new Map<string, { value: string; expiresAtMs: number }>();
  private localBoardLayers = new Map<string, LocalBoardLayersRecord>();
  private localBoardWriters = new Map<string, LocalBoardWriterRecord>();
  private localBoardMembershipCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private localBoardMembershipCleanupExpiry: number | null = null;
  // Legacy durable seq floor lookup for the `nextBoardSeq` dormancy reseed.
  // Available to DB-free legacy tests through `setBoardSeqFloorProvider`.
  // Production installs `boardSeqAllocator` below instead. Defaults to "no
  // durable floor" so a store with neither hook retains the old behavior.
  private boardSeqFloorProvider: (boardId: number) => Promise<number> = async () => 0;
  // Production sequence authority. Redis INCR supplies a candidate, then this
  // callback atomically reserves the final value in PostgreSQL. Nullable so
  // DB-free unit tests retain the legacy local/floor behavior.
  private boardSeqAllocator: BoardSeqAllocator | null = null;

  constructor(private readonly deps: BoardPresenceStoreDeps) {}

  /**
   * Inject the legacy durable seq-floor lookup used by DB-free dormancy tests.
   * Production installs `setBoardSeqAllocator` instead.
   */
  setBoardSeqFloorProvider(provider: (boardId: number) => Promise<number>): void {
    this.boardSeqFloorProvider = provider;
  }

  setBoardSeqAllocator(provider: BoardSeqAllocator | null): void {
    this.boardSeqAllocator = provider;
  }

  /**
   * Atomically allocate the next monotonic sequence number for a board. Redis
   * `INCR` + `EXPIRE` (pipelined — 1 RTT) supplies a cluster-wide candidate;
   * the injected PostgreSQL allocator reserves the authoritative value and is
   * safe against a stale Redis key. Local-only mode supplies an in-memory
   * candidate to the same allocator.
   *
   * When no authoritative allocator is installed (DB-free tests / legacy
   * embedding), the key expires after a week of inactivity. For a fresh board
   * that's harmless (INCR restarts at 1 and the empty history buffer expired
   * along with it). For a board dormant *longer* than the TTL whose durable
   * `board_climb_events` rows outlive the key, restarting at 1 would collide
   * with / precede still-existing rows — so whenever INCR comes back small
   * (<= BOARD_SEQ_RESEED_THRESHOLD, the signature of a fresh key either way),
   * `ensureBoardSeqClearOfDurableFloor` checks the durable floor and, if the
   * floor is at or above the INCR result, reseeds atomically past it. The
   * check memoizes per board so a brand-new board's early sends don't repeat
   * the Postgres lookup ~50 times (see that method's safety analysis). A
   * FAILED consultation marks the board reseed-pending, which keeps the
   * consultation retrying on every subsequent allocation even after the
   * counter crosses the threshold — otherwise a transient Postgres blip in
   * the reseed window would leave the counter permanently below the durable
   * floor.
   */
  async nextBoardSeq(boardId: string, allocatorOverride?: BoardSeqAllocator): Promise<number> {
    const authoritativeAllocator = allocatorOverride ?? this.boardSeqAllocator;
    if (this.deps.isRedisAvailable()) {
      let redisCandidate: number | null = null;
      try {
        const { publisher } = redisClientManager.getClients();
        const key = `board:${boardId}:seq`;
        const results = await publisher.pipeline().incr(key).expire(key, BOARD_SEQ_TTL).exec();
        if (!results) {
          throw new Error('nextBoardSeq pipeline returned null');
        }
        const [incrError, incrResult] = results[0];
        if (incrError) throw incrError;
        redisCandidate = incrResult as number;
      } catch (error) {
        if (this.deps.isRedisRequired()) {
          this.deps.logger.error('[PubSub] Failed to allocate board seq from required Redis:', error);
          throw error;
        }
        this.deps.logger.error('[PubSub] Failed to allocate board seq from Redis, falling back to local:', error);
      }

      if (redisCandidate !== null) {
        // Keep the authoritative callback outside the Redis try/catch. A
        // Postgres/event-write failure is not a Redis outage and must reach the
        // caller once, rather than being mislabeled and retried with a local
        // candidate.
        if (authoritativeAllocator) {
          return await this.allocateAuthoritativeBoardSeq(boardId, redisCandidate, true, authoritativeAllocator);
        }

        try {
          if (redisCandidate <= BOARD_SEQ_RESEED_THRESHOLD || this.boardSeqReseedPending.has(boardId)) {
            return await this.ensureBoardSeqClearOfDurableFloor(boardId, redisCandidate);
          }
          return redisCandidate;
        } catch (error) {
          if (this.deps.isRedisRequired()) {
            this.deps.logger.error('[PubSub] Failed to reseed board seq with required Redis:', error);
            throw error;
          }
          this.deps.logger.error('[PubSub] Failed to reseed board seq, falling back to local:', error);
        }
      }
    }

    const next = (this.localBoardSeq.get(boardId) ?? 0) + 1;
    if (authoritativeAllocator) {
      return await this.allocateAuthoritativeBoardSeq(boardId, next, false, authoritativeAllocator);
    }
    this.localBoardSeq.set(boardId, next);
    return next;
  }

  private async allocateAuthoritativeBoardSeq(
    boardId: string,
    candidate: number,
    candidateCameFromRedis: boolean,
    allocator: BoardSeqAllocator,
  ): Promise<number> {
    const numericBoardId = Number(boardId);
    if (!Number.isSafeInteger(numericBoardId) || numericBoardId <= 0) {
      throw new Error(`Cannot reserve a durable sequence for invalid board id ${boardId}`);
    }

    const allocated = await allocator(numericBoardId, candidate);
    if (!Number.isSafeInteger(allocated) || allocated < candidate) {
      throw new Error(
        `Durable board sequence allocator returned invalid value ${allocated} for candidate ${candidate}`,
      );
    }
    this.localBoardSeq.set(boardId, Math.max(this.localBoardSeq.get(boardId) ?? 0, allocated));

    if (candidateCameFromRedis && allocated > candidate) {
      try {
        const mirrored = await this.raiseBoardSeqToAtLeast(boardId, allocated);
        if (mirrored === null) throw new Error('Redis became unavailable before the board sequence could be mirrored');
      } catch (error) {
        // PostgreSQL has already reserved `allocated`, so this mirror is only
        // an acceleration hint: every later candidate is checked against the
        // durable counter again. Do not fail the accepted report after its
        // reservation (and possibly its durable event) has committed.
        this.deps.logger.error('[PubSub] Failed to mirror authoritative board seq to Redis:', error);
      }
    }

    return allocated;
  }

  /**
   * Ensures a small (or reseed-pending) INCR result is clear of the durable
   * `board_climb_events` floor, reseeding atomically via
   * `allocateBoardSeqAtLeast` when it isn't. Returns the seq to use. Never
   * throws: a floor-lookup or reseed failure falls back to the INCR result —
   * but marks the board reseed-pending, so every subsequent allocation
   * retries the consultation (bypassing the watermark skip) until one
   * succeeds. Without the sticky flag, a transient Postgres blip covering
   * the whole <= BOARD_SEQ_RESEED_THRESHOLD window would let the counter
   * cross the threshold still below the durable floor and never consult
   * Postgres again — clients holding pre-reset high seqs would then treat
   * every subsequent event as stale and the live wall would freeze until the
   * next counter loss.
   *
   * Memoization: without it, every send of a brand-new board's first
   * ~BOARD_SEQ_RESEED_THRESHOLD would run the MAX(seq) Postgres lookup. The
   * memo is a per-board watermark = the highest seq this instance has either
   * verified clear of the floor or allocated through this check; the lookup
   * is skipped only when the fresh INCR result is strictly ahead of it
   * (normal early-life counter growth, provably not a reset this instance
   * could collide on). Deliberately NOT the raw floor value: a floor-only
   * memo (e.g. 0 for a new board) would keep skipping after a mid-process
   * counter loss (FLUSHALL / failover to an empty replica) once durable rows
   * exist — INCR restarts at 1, `1 > 0` skips, collision. With the
   * watermark, any allocation pushes it to >= 1, so the first post-reset
   * INCR (= 1) can never be ahead of it and always re-consults the floor.
   *
   * Accepted residual (documented, not defended): in multi-instance, an
   * instance holding a small stale watermark can race another instance's
   * first post-reset reseed and skip the check for a seq the durable floor
   * already covers. The colliding durable insert lands on the (boardId, seq)
   * unique index's `onConflictDoNothing` — one dropped duplicate row, no
   * corruption, and exactly the failure mode every post-dormancy send had
   * before the reseed existed. That needs a mid-process Redis counter loss
   * (not mere dormancy — any send or stats publish re-arms the TTL) plus
   * concurrent sends in the reseed window, so we take the simple memo.
   */
  private async ensureBoardSeqClearOfDurableFloor(boardId: string, incrResult: number): Promise<number> {
    const reseedPending = this.boardSeqReseedPending.has(boardId);
    const verifiedThrough = this.boardSeqVerifiedThrough.get(boardId);
    // The watermark skip is only trustworthy when no consultation has failed
    // since the last success — while reseed-pending, the floor may be far
    // above anything this instance ever verified, so always re-consult.
    if (!reseedPending && verifiedThrough !== undefined && incrResult > verifiedThrough) {
      this.boardSeqVerifiedThrough.set(boardId, incrResult);
      return incrResult;
    }

    let floor: number;
    try {
      floor = await this.boardSeqFloorProvider(Number(boardId));
    } catch (error) {
      this.boardSeqReseedPending.add(boardId);
      this.deps.logger.error('[PubSub] board seq floor provider failed, using INCR result (reseed pending):', error);
      return incrResult;
    }

    if (floor < incrResult) {
      this.boardSeqReseedPending.delete(boardId);
      this.boardSeqVerifiedThrough.set(boardId, Math.max(incrResult, verifiedThrough ?? 0));
      return incrResult;
    }

    try {
      const reseeded = await this.allocateBoardSeqAtLeast(boardId, floor);
      if (reseeded === null) {
        // Redis went away between the INCR and the reseed — keep retrying.
        this.boardSeqReseedPending.add(boardId);
        return incrResult;
      }
      this.boardSeqReseedPending.delete(boardId);
      this.boardSeqVerifiedThrough.set(boardId, Math.max(reseeded, verifiedThrough ?? 0));
      return reseeded;
    } catch (error) {
      this.boardSeqReseedPending.add(boardId);
      this.deps.logger.error('[PubSub] board seq Lua reseed failed, using INCR result (reseed pending):', error);
      return incrResult;
    }
  }

  /**
   * Atomically allocate a board seq value guaranteed to exceed both the
   * current Redis counter and `floor` (`max(currentValue, floor) + 1`),
   * re-arming the TTL. A single Lua script keeps the read-compare-write
   * atomic under concurrent callers — two racing reseeds still get distinct,
   * monotonic results because Redis serializes the script execution.
   * Redis-only: returns null when Redis is unavailable (callers fall back to
   * the plain INCR result and mark the reseed pending). May still reject on
   * a command failure against a connected Redis — the internal reseed path
   * catches that. Public for direct unit testing.
   */
  async allocateBoardSeqAtLeast(boardId: string, floor: number): Promise<number | null> {
    if (!this.deps.isRedisAvailable()) return null;
    const { publisher } = redisClientManager.getClients();
    const key = `board:${boardId}:seq`;
    const result = await publisher.eval(
      "local cur = tonumber(redis.call('get', KEYS[1]) or '0'); " +
        'local nxt = math.max(cur, tonumber(ARGV[1])) + 1; ' +
        "redis.call('set', KEYS[1], nxt); " +
        "redis.call('expire', KEYS[1], ARGV[2]); " +
        'return nxt',
      1,
      key,
      floor,
      BOARD_SEQ_TTL,
    );
    return Number(result);
  }

  /** Raise Redis to `floor` without consuming another sequence value. */
  private async raiseBoardSeqToAtLeast(boardId: string, floor: number): Promise<number | null> {
    if (!this.deps.isRedisAvailable()) return null;
    const { publisher } = redisClientManager.getClients();
    const key = `board:${boardId}:seq`;
    const result = await publisher.eval(
      "local cur = tonumber(redis.call('get', KEYS[1]) or '0'); " +
        'local nxt = math.max(cur, tonumber(ARGV[1])); ' +
        "redis.call('set', KEYS[1], nxt); " +
        "redis.call('expire', KEYS[1], ARGV[2]); " +
        'return nxt',
      1,
      key,
      floor,
      BOARD_SEQ_TTL,
    );
    return Number(result);
  }

  /**
   * Read a board's recent climbs, newest-first by seq (cap 50). Empty without
   * Redis.
   */
  async getRecentBoardClimbs(boardId: string): Promise<BoardPresenceClimb[]> {
    if (!this.deps.isRedisAvailable()) {
      return [];
    }

    try {
      const { publisher } = redisClientManager.getClients();
      const key = `board:${boardId}:history`;
      const entries = await publisher.lrange(key, 0, -1);

      const climbs: BoardPresenceClimb[] = [];
      for (const json of entries) {
        try {
          climbs.push(BoardPresenceClimbRedisSchema.parse(JSON.parse(json)));
        } catch (parseError) {
          this.deps.logger.error('[PubSub] Failed to validate board history entry:', parseError);
        }
      }

      // The list is already newest-first (lpush), but sort by seq DESC so a
      // late, out-of-order write can't surface above a newer climb.
      climbs.sort((a, b) => b.seq - a.seq);
      return climbs.slice(0, BOARD_HISTORY_SIZE);
    } catch (error) {
      this.deps.logger.error('[PubSub] Failed to read board history:', error);
      return [];
    }
  }

  /** Read the latest confirmed, sanitized QuantumBoard roster. */
  async getBoardLayers(boardId: string): Promise<BoardLayersSnapshot | null> {
    if (!this.deps.isRedisAvailable()) {
      const local = this.readLocalBoardLayers(boardId);
      return local === null ? null : ageBoardLayersSnapshot(local);
    }

    try {
      const { publisher } = redisClientManager.getClients();
      const raw = await publisher.get(`board:${boardId}:layers`);
      const remote = raw === null ? null : ageBoardLayersSnapshot(parseBoardLayersSnapshot(raw, boardId));
      const localSnapshot = this.readLocalBoardLayers(boardId);
      const local = localSnapshot === null ? null : ageBoardLayersSnapshot(localSnapshot);
      return local !== null && (remote === null || local.seq > remote.seq) ? local : remote;
    } catch (error) {
      if (this.deps.isRedisRequired()) throw error;
      this.deps.logger.error('[PubSub] Failed to read board layers:', error);
      const local = this.readLocalBoardLayers(boardId);
      return local === null ? null : ageBoardLayersSnapshot(local);
    }
  }

  /** Atomically commit a confirmed roster together with its public writer and
   * per-connection claim. The private claim prevents an old socket belonging
   * to the same authenticated user from clearing or staling a reconnect's
   * newer roster. */
  async commitBoardLayers(
    boardId: string,
    snapshot: BoardLayersSnapshot,
    emitterId: string,
    claimToken: string,
  ): Promise<CommitBoardLayersResult> {
    if (!this.deps.isRedisAvailable()) {
      if (this.deps.isRedisRequired()) throw new Error('Redis is required to commit Quantum board layers');
      return this.commitLocalBoardLayers(boardId, snapshot, emitterId, claimToken);
    }

    try {
      const { publisher } = redisClientManager.getClients();
      const encodedResult = await publisher.eval(
        "local current = redis.call('get', KEYS[3]); " +
          'if current then local decoded = cjson.decode(current); if tonumber(decoded.seq) >= tonumber(ARGV[4]) then return cjson.encode({accepted=false, snapshot=decoded, previousWriter=cjson.null, previousClaimToken=cjson.null}) end end; ' +
          "local previousWriter = redis.call('get', KEYS[1]); local previousClaim = redis.call('get', KEYS[2]); " +
          "redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[5]); redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[5]); " +
          "redis.call('set', KEYS[3], ARGV[3], 'EX', ARGV[6]); redis.call('set', KEYS[4], ARGV[2], 'EX', ARGV[6]); " +
          'return cjson.encode({accepted=true, snapshot=cjson.decode(ARGV[3]), previousWriter=previousWriter or cjson.null, previousClaimToken=previousClaim or cjson.null})',
        4,
        `board:${boardId}:writer`,
        `board:${boardId}:layers:claim`,
        `board:${boardId}:layers`,
        `board:${boardId}:layers:owner`,
        emitterId,
        claimToken,
        JSON.stringify(snapshot),
        snapshot.seq,
        BOARD_MEMBERSHIP_TTL,
        boardLayersTtlSeconds(snapshot),
      );
      if (typeof encodedResult !== 'string') throw new Error('Invalid Quantum layer commit response');
      const result = CommitBoardLayersResultRedisSchema.parse(JSON.parse(encodedResult));
      if (String(result.snapshot.boardId) !== boardId) {
        throw new Error(`Quantum layer commit board ${result.snapshot.boardId} does not match Redis key ${boardId}`);
      }
      this.localBoardLayers.delete(boardId);
      this.localBoardWriters.delete(boardId);
      return { ...result, snapshot: ageBoardLayersSnapshot(result.snapshot) };
    } catch (error) {
      if (this.deps.isRedisRequired()) throw error;
      this.deps.logger.error('[PubSub] Failed to commit board layers, falling back to local:', error);
      return this.commitLocalBoardLayers(boardId, snapshot, emitterId, claimToken);
    }
  }

  private commitLocalBoardLayers(
    boardId: string,
    snapshot: BoardLayersSnapshot,
    emitterId: string,
    claimToken: string,
  ): CommitBoardLayersResult {
    const current = this.readLocalBoardLayersRecord(boardId);
    if (current !== null && current.snapshot.seq >= snapshot.seq) {
      return {
        snapshot: current.snapshot,
        accepted: false,
        previousWriter: null,
        previousClaimToken: null,
      };
    }
    const previousWriter = this.readLocalBoardWriterRecord(boardId);
    this.localBoardWriters.set(boardId, {
      emitterId,
      layerClaimToken: claimToken,
      expiresAtMs: Date.now() + BOARD_MEMBERSHIP_TTL * 1000,
    });
    this.localBoardLayers.set(boardId, {
      snapshot,
      ownerToken: claimToken,
      expiresAtMs: Date.now() + boardLayersTtlSeconds(snapshot) * 1000,
    });
    return {
      snapshot,
      accepted: true,
      previousWriter: previousWriter?.emitterId ?? null,
      previousClaimToken: previousWriter?.layerClaimToken ?? null,
    };
  }

  /** Mark a roster stale only while it still belongs to the emitter whose
   * writer claim was cleared. The Redis comparison and write are atomic, so a
   * new reporter cannot be staled between the ownership check and update. */
  async markBoardLayersStaleIfOwned(
    boardId: string,
    ownerToken: string,
    staleSnapshot: BoardLayersSnapshot,
  ): Promise<BoardLayersStaleResult | null> {
    const localBeforeRedis = this.readLocalBoardLayersRecord(boardId);
    if (localBeforeRedis && localBeforeRedis.ownerToken !== ownerToken) {
      return { snapshot: localBeforeRedis.snapshot, changed: false };
    }
    if (!this.deps.isRedisAvailable()) {
      const current = localBeforeRedis;
      if (!current) return null;
      if (current.ownerToken !== ownerToken || current.snapshot.stale || current.snapshot.seq >= staleSnapshot.seq) {
        return { snapshot: current.snapshot, changed: false };
      }
      this.localBoardLayers.set(boardId, {
        snapshot: staleSnapshot,
        ownerToken,
        expiresAtMs: Date.now() + boardLayersTtlSeconds(staleSnapshot) * 1000,
      });
      return { snapshot: staleSnapshot, changed: true };
    }

    try {
      const { publisher } = redisClientManager.getClients();
      const encodedResult = await publisher.eval(
        "local current = redis.call('get', KEYS[1]); if not current then return '' end; " +
          "local owner = redis.call('get', KEYS[2]); local decoded = cjson.decode(current); " +
          "if owner ~= ARGV[1] or decoded.stale == true or tonumber(decoded.seq) >= tonumber(ARGV[3]) then return '0' .. current end; " +
          "redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[4]); redis.call('expire', KEYS[2], ARGV[4]); return '1' .. ARGV[2]",
        2,
        `board:${boardId}:layers`,
        `board:${boardId}:layers:owner`,
        ownerToken,
        JSON.stringify(staleSnapshot),
        staleSnapshot.seq,
        boardLayersTtlSeconds(staleSnapshot),
      );
      const result = String(encodedResult);
      if (result === '') return null;
      return {
        changed: result[0] === '1',
        snapshot: parseBoardLayersSnapshot(result.slice(1), boardId),
      };
    } catch (error) {
      if (this.deps.isRedisRequired()) throw error;
      this.deps.logger.error('[PubSub] Failed to conditionally stale board layers:', error);
      const current = this.readLocalBoardLayersRecord(boardId);
      if (!current || current.ownerToken !== ownerToken)
        return current ? { snapshot: current.snapshot, changed: false } : null;
      if (current.snapshot.stale || current.snapshot.seq >= staleSnapshot.seq) {
        return { snapshot: current.snapshot, changed: false };
      }
      this.localBoardLayers.set(boardId, {
        snapshot: staleSnapshot,
        ownerToken,
        expiresAtMs: Date.now() + boardLayersTtlSeconds(staleSnapshot) * 1000,
      });
      return { snapshot: staleSnapshot, changed: true };
    }
  }

  private readLocalBoardLayers(boardId: string): BoardLayersSnapshot | null {
    return this.readLocalBoardLayersRecord(boardId)?.snapshot ?? null;
  }

  private readLocalBoardLayersRecord(boardId: string): LocalBoardLayersRecord | null {
    const local = this.localBoardLayers.get(boardId);
    if (!local) return null;
    if (local.expiresAtMs <= Date.now()) {
      this.localBoardLayers.delete(boardId);
      return null;
    }
    return local;
  }

  /**
   * Record that a user is connected to a board (proof-of-presence), stamped on
   * resolveBoardForSerial / resolveBoardForConfig. `reportBoardClimb` requires
   * this so a logged-in user can't inject onto a board they never connected to.
   * TTL'd; a reconnect re-stamps. Best-effort without Redis (local map).
   */
  async stampBoardMembership(boardId: string, userId: string): Promise<void> {
    const key = `presence:board:${boardId}:user:${userId}`;
    if (this.deps.isRedisAvailable()) {
      try {
        const { publisher } = redisClientManager.getClients();
        // Store the first-seen epoch-ms (NX preserves it across reconnects) so
        // the durable-history dwell gate can tell how long this member has been
        // on the board. A separate EXPIRE keeps the key alive while they're
        // active without resetting first-seen. EXISTS still answers presence.
        await publisher.set(key, String(Date.now()), 'EX', BOARD_MEMBERSHIP_TTL, 'NX');
        await publisher.expire(key, BOARD_MEMBERSHIP_TTL);
        return;
      } catch (error) {
        if (this.deps.isRedisRequired()) {
          this.deps.logger.error('[PubSub] Failed to stamp board membership in required Redis:', error);
          throw error;
        }
        this.deps.logger.error('[PubSub] Failed to stamp board membership, falling back to local:', error);
      }
    }
    this.setLocalBoardMembership(`${boardId}:${userId}`, Date.now() + BOARD_MEMBERSHIP_TTL * 1000);
  }

  /** True if the user has a live proof-of-presence stamp for the board. */
  async hasBoardMembership(boardId: string, userId: string): Promise<boolean> {
    const key = `presence:board:${boardId}:user:${userId}`;
    if (this.deps.isRedisAvailable()) {
      try {
        const { publisher } = redisClientManager.getClients();
        return (await publisher.exists(key)) === 1;
      } catch (error) {
        if (this.deps.isRedisRequired()) {
          this.deps.logger.error('[PubSub] Failed to check board membership in required Redis:', error);
          throw error;
        }
        this.deps.logger.error('[PubSub] Failed to check board membership, falling back to local:', error);
      }
    }
    return this.checkLocalBoardMembership(boardId, userId);
  }

  private checkLocalBoardMembership(boardId: string, userId: string): boolean {
    const localKey = `${boardId}:${userId}`;
    const expiry = this.localBoardMembership.get(localKey);
    if (expiry === undefined) return false;
    if (expiry <= Date.now()) {
      this.localBoardMembership.delete(localKey);
      return false;
    }
    return true;
  }

  /**
   * One Redis pipeline (1 RTT) that answers everything `reportBoardClimb`'s
   * Stage A needs before validating the incoming climb: proof-of-presence
   * (+ first-seen, for the durable-history dwell gate), the last-report dedup
   * marker (for write-side idempotency, A2), and the current writer (so the
   * dedup short-circuit can require the retrying emitter to still hold the
   * wall — see `BoardReportGate.currentWriter`). Replaces what used to be
   * separate `hasBoardMembership` + first-seen + `lastReport` reads — 3 RTTs
   * collapsed into 1, with the writer read riding the same pipeline for free.
   *
   * Preserves `hasBoardMembership`'s fail-closed `redisRequired` semantics
   * (throws when Redis is required but the pipeline fails) and the
   * plausible-epoch guard on `firstSeenMs` (a legacy/implausible stamp still
   * counts as a member but never satisfies the dwell gate). Local-only
   * fallback mirrors today: membership from the in-memory map,
   * `firstSeenMs`/`lastReport`/`currentWriter` unknown (null) — durable
   * history and write-side dedup both degrade to off without Redis, same as
   * before.
   */
  async getBoardReportGate(boardId: string, emitterId: string): Promise<BoardReportGate> {
    const membershipKey = `presence:board:${boardId}:user:${emitterId}`;
    const lastReportKey = `board:${boardId}:lastReport`;
    const writerKey = `board:${boardId}:writer`;

    if (this.deps.isRedisAvailable()) {
      try {
        const { publisher } = redisClientManager.getClients();
        const results = await publisher.pipeline().get(membershipKey).get(lastReportKey).get(writerKey).exec();
        if (!results) {
          throw new Error('getBoardReportGate pipeline returned null');
        }
        const [[membershipError, membershipRaw], [lastReportError, lastReportRaw], [writerError, writerRaw]] = results;
        if (membershipError) throw membershipError;
        if (lastReportError) throw lastReportError;
        if (writerError) throw writerError;
        const raw = membershipRaw as string | null;
        return {
          isMember: raw !== null,
          firstSeenMs: parsePlausibleFirstSeenMs(raw),
          lastReport: (lastReportRaw as string | null) ?? null,
          currentWriter: (writerRaw as string | null) ?? null,
        };
      } catch (error) {
        if (this.deps.isRedisRequired()) {
          this.deps.logger.error('[PubSub] Failed to read board report gate from required Redis:', error);
          throw error;
        }
        this.deps.logger.error('[PubSub] Failed to read board report gate, falling back to local:', error);
      }
    }

    return {
      isMember: this.checkLocalBoardMembership(boardId, emitterId),
      firstSeenMs: null,
      lastReport: null,
      currentWriter: null,
    };
  }

  /**
   * One Redis pipeline (1 RTT) that commits an accepted `reportBoardClimb`
   * send: appends to the durable FIFO history (LPUSH/LTRIM/EXPIRE), takes the
   * connection-holder slot (atomic `SET writer EX GET` — a single command, so
   * two concurrent reports still can't both observe the same previous
   * holder), stamps the write-side dedup marker (A2's `lastReport`), and —
   * when this connection is in a party session — remembers the session→board
   * mapping (`session:{id}:board`). Replaces what used to be 3 separate
   * round trips.
   *
   * Non-fatal: the whole pipeline (or an individual command within it) can
   * fail without failing the accepted report — failures are logged and
   * swallowed. But a swallowed failure means `previousWriter: null` is a
   * fabrication, not an observation, so the result also carries
   * `writerSlotOk`: false whenever the writer slot didn't verifiably execute
   * (Redis off, pipeline threw, or the SET..GET slot itself errored). The
   * resolver gates the hand-off broadcast on it — without that gate, a
   * failing pipeline would look like "board was free" on every send and
   * spuriously re-broadcast the hand-off each time (the pre-pipeline code
   * never had this failure mode: a writer-update failure was either swallowed
   * with no broadcast, or thrown in redisRequired mode).
   */
  async commitBoardClimb(input: CommitBoardClimbInput): Promise<CommitBoardClimbResult> {
    if (!this.deps.isRedisAvailable()) {
      // Redis-less single-instance fallback: still remember the session↔board
      // binding in-memory so getSessionBoard/getBoardSession keep answering
      // (the board-queue-preview producer depends on them). The writer slot
      // and history remain Redis-only, unchanged.
      const sessionBindingChanged = this.rememberLocalSessionBoardBinding(input.sessionId, input.boardId);
      return { previousWriter: null, writerSlotOk: false, sessionBindingChanged };
    }

    try {
      const { publisher } = redisClientManager.getClients();
      const historyKey = `board:${input.boardId}:history`;
      const writerKey = `board:${input.boardId}:writer`;
      const lastReportKey = `board:${input.boardId}:lastReport`;
      const lastReportValue = `${input.emitterId}|${input.climbUuid}|${input.effectiveAngle}`;

      const pipeline = publisher.pipeline();
      const commandLabels: string[] = [];
      pipeline.lpush(historyKey, JSON.stringify(input.climb));
      commandLabels.push('history-lpush');
      pipeline.ltrim(historyKey, 0, BOARD_HISTORY_SIZE - 1);
      commandLabels.push('history-ltrim');
      pipeline.expire(historyKey, BOARD_HISTORY_TTL);
      commandLabels.push('history-expire');
      const writerCommandIndex = commandLabels.length;
      pipeline.eval(
        "local previous = redis.call('get', KEYS[1]); redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2]); redis.call('del', KEYS[2]); return previous or false",
        2,
        writerKey,
        `board:${input.boardId}:layers:claim`,
        input.emitterId,
        BOARD_MEMBERSHIP_TTL,
      );
      commandLabels.push('writer-set');
      pipeline.set(lastReportKey, lastReportValue, 'PX', REPORT_DEDUP_WINDOW_MS);
      commandLabels.push('last-report-set');
      let boardSessionCommandIndex = -1;
      if (input.sessionId) {
        pipeline.set(`session:${input.sessionId}:board`, input.boardId, 'EX', BOARD_MEMBERSHIP_TTL);
        commandLabels.push('session-board-set');
        // Reverse binding for the board-keyed queue preview (gym kiosks):
        // `getBoardSession(boardId)` answers "which session's queue is on this
        // wall". Same TTL/re-stamp lifecycle as the forward key — a fresh send
        // re-stamps both, an idle binding expires with proof-of-presence.
        // SET..GET (like the writer slot) so the caller learns whether this
        // send just bound a NEW session to the wall (sessionBindingChanged).
        boardSessionCommandIndex = commandLabels.length;
        pipeline.set(`board:${input.boardId}:session`, input.sessionId, 'EX', BOARD_MEMBERSHIP_TTL, 'GET');
        commandLabels.push('board-session-set');
      }

      const results = await pipeline.exec();
      if (!results) {
        throw new Error('commitBoardClimb pipeline returned null');
      }

      results.forEach(([error], index) => {
        if (error) {
          this.deps.logger.warn(`[PubSub] commitBoardClimb ${commandLabels[index]} command failed: ${String(error)}`);
        }
      });

      // Same verifiability rule as the writer slot: a failed binding slot means
      // the previous value is a fabrication, so report "unchanged" (the next
      // queue event re-gates and publishes anyway; a spurious "changed" is the
      // only side to avoid guessing on).
      let sessionBindingChanged = false;
      if (boardSessionCommandIndex !== -1) {
        const [bindingError, previousBoundSession] = results[boardSessionCommandIndex];
        sessionBindingChanged = !bindingError && ((previousBoundSession as string | null) ?? null) !== input.sessionId;
      }

      const [writerError, writerValue] = results[writerCommandIndex];
      if (writerError) return { previousWriter: null, writerSlotOk: false, sessionBindingChanged };
      return { previousWriter: (writerValue as string | null) ?? null, writerSlotOk: true, sessionBindingChanged };
    } catch (error) {
      this.deps.logger.error('[PubSub] commitBoardClimb pipeline failed:', error);
      return { previousWriter: null, writerSlotOk: false, sessionBindingChanged: false };
    }
  }

  /**
   * Claim the writer slot without appending a single-climb history event.
   * Quantum uses this after authoritative roster readback because one
   * controller state can contain four simultaneous climbs.
   */
  async takeBoardWriter(boardId: string, emitterId: string): Promise<BoardWriterTakeResult> {
    if (!this.deps.isRedisAvailable()) {
      if (this.deps.isRedisRequired()) return { previousWriter: null, writerSlotOk: false };
      const previousWriter = this.readLocalBoardWriter(boardId);
      this.localBoardWriters.set(boardId, {
        emitterId,
        expiresAtMs: Date.now() + BOARD_MEMBERSHIP_TTL * 1000,
      });
      return { previousWriter, writerSlotOk: true };
    }

    try {
      const { publisher } = redisClientManager.getClients();
      const previousWriter = await publisher.eval(
        "local previous = redis.call('get', KEYS[1]); redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2]); redis.call('del', KEYS[2]); return previous or false",
        2,
        `board:${boardId}:writer`,
        `board:${boardId}:layers:claim`,
        emitterId,
        BOARD_MEMBERSHIP_TTL,
      );
      this.localBoardWriters.delete(boardId);
      return { previousWriter: typeof previousWriter === 'string' ? previousWriter : null, writerSlotOk: true };
    } catch (error) {
      if (this.deps.isRedisRequired()) throw error;
      this.deps.logger.error('[PubSub] Failed to take board writer, falling back to local:', error);
      const previousWriter = this.readLocalBoardWriter(boardId);
      this.localBoardWriters.set(boardId, {
        emitterId,
        expiresAtMs: Date.now() + BOARD_MEMBERSHIP_TTL * 1000,
      });
      return { previousWriter, writerSlotOk: true };
    }
  }

  /**
   * Clear the board's holder only if `emitterId` still holds it (atomic
   * compare-and-delete), so a holder who was already booted can't wipe the new
   * one. Returns whether it was actually cleared.
   */
  async clearBoardWriterIf(boardId: string, emitterId: string, layerClaimToken?: string): Promise<boolean> {
    if (!this.deps.isRedisAvailable()) {
      const current = this.readLocalBoardWriterRecord(boardId);
      if (
        current?.emitterId !== emitterId ||
        (current.layerClaimToken !== undefined && current.layerClaimToken !== layerClaimToken)
      ) {
        return false;
      }
      this.localBoardWriters.delete(boardId);
      return true;
    }
    try {
      const { publisher } = redisClientManager.getClients();
      const cleared = await publisher.eval(
        "local writer = redis.call('get', KEYS[1]); local claim = redis.call('get', KEYS[2]); if writer == ARGV[1] and (not claim or claim == ARGV[2]) then redis.call('del', KEYS[1], KEYS[2]); return 1 else return 0 end",
        2,
        `board:${boardId}:writer`,
        `board:${boardId}:layers:claim`,
        emitterId,
        layerClaimToken ?? '',
      );
      const localWriter = this.readLocalBoardWriterRecord(boardId);
      const localCleared =
        localWriter?.emitterId === emitterId &&
        (localWriter.layerClaimToken === undefined || localWriter.layerClaimToken === layerClaimToken);
      if (localCleared) this.localBoardWriters.delete(boardId);
      return cleared === 1 || localCleared;
    } catch (error) {
      if (this.deps.isRedisRequired()) throw error;
      this.deps.logger.error('[PubSub] Failed to clear board writer:', error);
      const current = this.readLocalBoardWriterRecord(boardId);
      if (
        current?.emitterId !== emitterId ||
        (current.layerClaimToken !== undefined && current.layerClaimToken !== layerClaimToken)
      ) {
        return false;
      }
      this.localBoardWriters.delete(boardId);
      return true;
    }
  }

  /** The board's current connection holder emitter id, or null when free. */
  async getBoardWriter(boardId: string): Promise<string | null> {
    if (!this.deps.isRedisAvailable()) return this.readLocalBoardWriter(boardId);
    try {
      const { publisher } = redisClientManager.getClients();
      return (await publisher.get(`board:${boardId}:writer`)) ?? this.readLocalBoardWriter(boardId);
    } catch (error) {
      if (this.deps.isRedisRequired()) throw error;
      this.deps.logger.error('[PubSub] Failed to get board writer:', error);
      return this.readLocalBoardWriter(boardId);
    }
  }

  private readLocalBoardWriter(boardId: string): string | null {
    return this.readLocalBoardWriterRecord(boardId)?.emitterId ?? null;
  }

  private readLocalBoardWriterRecord(boardId: string): LocalBoardWriterRecord | null {
    const writer = this.localBoardWriters.get(boardId);
    if (!writer) return null;
    if (writer.expiresAtMs <= Date.now()) {
      this.localBoardWriters.delete(boardId);
      return null;
    }
    return writer;
  }

  /**
   * The shared board_id this party session is on, or null when unknown.
   *
   * The mapping (`session:{id}:board`) is written by `commitBoardClimb` as a
   * side-effect of `reportBoardClimb` — the only moment a session is provably
   * tied to a board. The APNs Live Activity path reads it to resolve the
   * board's current holder for a given session (`QueueState` and the
   * push-token rows carry sessionId but not boardId), and the
   * board-queue-preview producer reads it to route a session's queue events
   * to the right board channel. TTL'd to the same window as proof-of-presence
   * so an idle session's mapping doesn't leak; a fresh send re-stamps it.
   * Without Redis this falls back to the single-instance in-memory binding
   * written by `commitBoardClimb`'s local path.
   */
  async getSessionBoard(sessionId: string): Promise<string | null> {
    if (!this.deps.isRedisAvailable()) {
      return this.readLocalBinding(this.localSessionBoard, sessionId);
    }
    try {
      const { publisher } = redisClientManager.getClients();
      return await publisher.get(`session:${sessionId}:board`);
    } catch (error) {
      if (this.deps.isRedisRequired()) throw error;
      this.deps.logger.error('[PubSub] Failed to get session board:', error);
      return null;
    }
  }

  /**
   * The party session bound to this board, or null when unknown — the reverse
   * of `getSessionBoard`, written by the same `commitBoardClimb` pipeline
   * (`board:{id}:session`, same TTL). This is the board-keyed entry point for
   * the anonymous queue preview: a kiosk knows the boardId, never the session
   * UUID. Callers MUST still apply the privacy gates (anon-readable board +
   * `board_sessions.is_public`) before exposing anything derived from the
   * returned session. Without Redis this falls back to the single-instance
   * in-memory binding.
   */
  async getBoardSession(boardId: string): Promise<string | null> {
    if (!this.deps.isRedisAvailable()) {
      return this.readLocalBinding(this.localBoardSession, boardId);
    }
    try {
      const { publisher } = redisClientManager.getClients();
      return await publisher.get(`board:${boardId}:session`);
    } catch (error) {
      if (this.deps.isRedisRequired()) throw error;
      this.deps.logger.error('[PubSub] Failed to get board session:', error);
      return null;
    }
  }

  /**
   * Local-only (Redis-less) session↔board binding write. See the map docs.
   * Returns whether the board's reverse binding was created or changed by
   * this write (mirrors the Redis SET..GET path's `sessionBindingChanged`).
   */
  private rememberLocalSessionBoardBinding(sessionId: string | null, boardId: string): boolean {
    if (!sessionId) return false;
    const previousBoundSession = this.readLocalBinding(this.localBoardSession, boardId);
    const expiresAtMs = Date.now() + BOARD_MEMBERSHIP_TTL * 1000;
    this.localSessionBoard.set(sessionId, { value: boardId, expiresAtMs });
    this.localBoardSession.set(boardId, { value: sessionId, expiresAtMs });
    return previousBoundSession !== sessionId;
  }

  /** Read + lazily evict an entry from a local binding map. */
  private readLocalBinding(map: Map<string, { value: string; expiresAtMs: number }>, key: string): string | null {
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= Date.now()) {
      map.delete(key);
      return null;
    }
    return entry.value;
  }

  private setLocalBoardMembership(localKey: string, expiry: number): void {
    this.localBoardMembership.set(localKey, expiry);
    if (this.localBoardMembershipCleanupExpiry !== null && expiry >= this.localBoardMembershipCleanupExpiry) {
      return;
    }
    this.scheduleLocalBoardMembershipCleanup();
  }

  /** @internal Test hook for local-only proof-of-presence cleanup coverage. */
  resetLocalBoardMembershipForTest(): void {
    this.clearLocalBoardMembershipCleanupTimer();
    this.localBoardMembership.clear();
  }

  /** @internal Test hook for local-only proof-of-presence cleanup coverage. */
  setLocalBoardMembershipForTest(localKey: string, expiry: number): void {
    this.setLocalBoardMembership(localKey, expiry);
  }

  /** @internal Test hook for local-only proof-of-presence cleanup coverage. */
  hasLocalBoardMembershipForTest(localKey: string): boolean {
    return this.localBoardMembership.has(localKey);
  }

  private scheduleLocalBoardMembershipCleanup(): void {
    this.clearLocalBoardMembershipCleanupTimer();

    if (this.localBoardMembership.size === 0) {
      return;
    }

    // Local-only mode is single-process and expected to stay small; keep the
    // scheduler simple unless proof-of-presence cardinality becomes material.
    let nextExpiry: number | null = null;
    for (const expiry of this.localBoardMembership.values()) {
      nextExpiry = nextExpiry === null ? expiry : Math.min(nextExpiry, expiry);
    }
    if (nextExpiry === null) return;

    this.localBoardMembershipCleanupExpiry = nextExpiry;
    const cleanupDelay = Math.max(0, nextExpiry - Date.now());
    const cleanupTimer = setTimeout(() => {
      this.localBoardMembershipCleanupTimer = null;
      this.localBoardMembershipCleanupExpiry = null;
      this.evictExpiredLocalBoardMemberships();
      this.scheduleLocalBoardMembershipCleanup();
    }, cleanupDelay);
    this.localBoardMembershipCleanupTimer = cleanupTimer;
    if (typeof cleanupTimer === 'object') {
      cleanupTimer.unref?.();
    }
  }

  private clearLocalBoardMembershipCleanupTimer(): void {
    if (this.localBoardMembershipCleanupTimer === null) {
      return;
    }
    clearTimeout(this.localBoardMembershipCleanupTimer);
    this.localBoardMembershipCleanupTimer = null;
    this.localBoardMembershipCleanupExpiry = null;
  }

  private evictExpiredLocalBoardMemberships(now = Date.now()): void {
    for (const [localKey, expiry] of this.localBoardMembership) {
      if (expiry <= now) {
        this.localBoardMembership.delete(localKey);
      }
    }
  }
}
