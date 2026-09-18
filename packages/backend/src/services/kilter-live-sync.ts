import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { auroraCredentials, userBoardMappings } from '@boardsesh/db/schema';
import {
  fetchKilterLiveHistory,
  getStoredKilterAccessToken,
  KilterApiError,
  KilterLiveError,
} from '@boardsesh/kilter-sync/api';
import { db } from '../db/client';
import { redisClientManager } from '../redis/client';
import { logger } from '../utils/logger';
import { importKilterDisplays, matchKilterWall } from './kilter-live-import';

const HEARTBEAT_MS = 15_000;
const LEASE_MS = 60_000;
const UNMATCHED_WALL_RETRY_MS = 300_000;
const COORDINATION_READ_TIMEOUT_MS = 1_000;
const CONTROL_CHANNEL = 'boardsesh:kilter-live:changed';
const RENEW_OWNER = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2]); return 1 end
  if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return 1 end return 0`;
const RELEASE_OWNER = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
// Our Redis client targets standalone Redis. Cluster support would require
// migrating these board keys to a shared hash tag before using this two-key script.
const SAVE_NEXT = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3]) end return 0`;
type Viewer = { userId: string; connectionId: string; member: string };
type BoardWatch = {
  viewers: Map<string, Viewer>;
  reconciling: boolean;
  controller: AbortController | null;
  nextPollAt: number;
  failures: number;
  owned: boolean;
  nextTimer: ReturnType<typeof setTimeout> | null;
  rerun: boolean;
  accountUserId: string | null;
};

async function readCoordination<Result>(operation: Promise<Result>): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Kilter live coordination read timed out')),
          COORDINATION_READ_TIMEOUT_MS,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Subscription-driven, cluster-coordinated polling. No background board crawl. */
export class KilterLiveSync {
  private readonly owner = randomUUID();
  private readonly boards = new Map<number, BoardWatch>();
  private readonly rejectedAccounts = new Map<string, { linkIdentity: string; until: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private controlSubscribed = false;
  private readonly onControl = (channel: string, message: string) => {
    if (channel !== CONTROL_CHANNEL) return;
    if (message === '*') {
      for (const boardId of this.boards.keys()) void this.reconcile(boardId);
      return;
    }
    const boardId = Number(message);
    if (this.boards.has(boardId)) void this.reconcile(boardId);
  };

  watch(boardId: number, userId: string, connectionId: string): () => void {
    if (process.env.KILTER_LIVE_SYNC_ENABLED !== '1' || this.stopped) return () => {};
    let board = this.boards.get(boardId);
    if (!board) {
      board = {
        viewers: new Map(),
        reconciling: false,
        controller: null,
        nextPollAt: 0,
        failures: 0,
        owned: false,
        nextTimer: null,
        rerun: false,
        accountUserId: null,
      };
      this.boards.set(boardId, board);
    }
    const token = randomUUID();
    board.viewers.set(token, { userId, connectionId, member: JSON.stringify([userId, this.owner, token]) });
    if (!this.timer) {
      this.timer = setInterval(() => {
        for (const activeBoardId of this.boards.keys()) void this.reconcile(activeBoardId);
      }, HEARTBEAT_MS);
      this.timer.unref();
    }
    void this.reconcile(boardId);
    return () => {
      void this.removeViewer(boardId, token);
    };
  }

  releaseConnection(connectionId: string): void {
    for (const [boardId, board] of this.boards) {
      const viewersToRemove = [...board.viewers];
      for (const [token, viewer] of viewersToRemove) {
        if (viewer.connectionId === connectionId) void this.removeViewer(boardId, token);
      }
    }
  }

  async credentialsChanged(): Promise<void> {
    if (process.env.KILTER_LIVE_SYNC_ENABLED !== '1') return;
    for (const boardId of this.boards.keys()) void this.reconcile(boardId);
    if (redisClientManager.isRedisConnected())
      await redisClientManager.getClients().publisher.publish(CONTROL_CHANNEL, '*');
  }

  private schedule(boardId: number, board: BoardWatch, delay: number): void {
    if (board.nextTimer) clearTimeout(board.nextTimer);
    if (this.stopped || this.boards.get(boardId) !== board) return;
    board.nextTimer = setTimeout(
      () => {
        board.nextTimer = null;
        void this.reconcile(boardId);
      },
      Math.max(1, delay),
    );
    board.nextTimer.unref();
  }

  private async removeViewer(boardId: number, token: string): Promise<void> {
    const board = this.boards.get(boardId);
    const viewer = board?.viewers.get(token);
    if (!viewer) return;
    board!.viewers.delete(token);
    try {
      if (redisClientManager.isRedisConnected()) {
        const publisher = redisClientManager.getClients().publisher;
        await publisher.zrem(`kilter-live:${boardId}:viewers`, viewer.member);
        await publisher.publish(CONTROL_CHANNEL, String(boardId));
      }
      await this.reconcile(boardId);
    } catch (error) {
      board?.controller?.abort();
      logger.warn('[KilterLive] Viewer removal coordination failed', {
        boardId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private async eligibleViewers(boardId: number, reader: Pick<typeof db, 'select'> = db) {
    const publisher = redisClientManager.getClients().publisher;
    const members = await readCoordination(
      publisher.zrangebyscore(`kilter-live:${boardId}:viewers`, Date.now(), '+inf'),
    );
    const userIds = new Set<string>();
    for (const member of members) {
      try {
        const parsed: unknown = JSON.parse(member);
        if (Array.isArray(parsed) && typeof parsed[0] === 'string') userIds.add(parsed[0]);
      } catch {
        /* ignore expired/invalid bookkeeping */
      }
    }
    if (!userIds.size) return [];
    const credentials = await reader
      .select({
        userId: auroraCredentials.userId,
        kilterId: userBoardMappings.boardUserIdText,
        linkedAt: userBoardMappings.linkedAt,
      })
      .from(auroraCredentials)
      .innerJoin(
        userBoardMappings,
        and(eq(userBoardMappings.userId, auroraCredentials.userId), eq(userBoardMappings.boardType, 'kilter')),
      )
      .where(
        and(
          inArray(auroraCredentials.userId, [...userIds]),
          eq(auroraCredentials.boardType, 'kilter'),
          isNotNull(auroraCredentials.encryptedRefreshToken),
          isNotNull(userBoardMappings.boardUserIdText),
          inArray(auroraCredentials.syncStatus, ['pending', 'active', 'error']),
        ),
      );
    for (const [userId, rejection] of this.rejectedAccounts) {
      if (rejection.until <= Date.now()) this.rejectedAccounts.delete(userId);
    }
    return credentials
      .map((credential) => ({
        userId: credential.userId,
        linkIdentity: `${credential.kilterId}:${credential.linkedAt.toISOString()}`,
      }))
      .filter((credential) => {
        const rejection = this.rejectedAccounts.get(credential.userId);
        return !rejection || rejection.linkIdentity !== credential.linkIdentity || rejection.until <= Date.now();
      })
      .sort((left, right) => left.userId.localeCompare(right.userId));
  }

  private async reconcile(boardId: number): Promise<void> {
    const board = this.boards.get(boardId);
    if (!board || this.stopped) return;
    if (board.reconciling) {
      board.rerun = true;
      return;
    }
    board.reconciling = true;
    try {
      if (!redisClientManager.isRedisConnected()) {
        board.controller?.abort();
        return;
      }
      const { publisher, subscriber } = redisClientManager.getClients();
      if (!this.controlSubscribed) {
        this.controlSubscribed = true;
        subscriber.on('message', this.onControl);
        try {
          await subscriber.subscribe(CONTROL_CHANNEL);
        } catch (error) {
          this.controlSubscribed = false;
          subscriber.off('message', this.onControl);
          throw error;
        }
      }
      const viewersKey = `kilter-live:${boardId}:viewers`;
      const pipeline = publisher.pipeline().zremrangebyscore(viewersKey, '-inf', Date.now());
      for (const viewer of board.viewers.values()) pipeline.zadd(viewersKey, Date.now() + LEASE_MS, viewer.member);
      pipeline.pexpire(viewersKey, LEASE_MS);
      const results = await pipeline.exec();
      if (!results || results.some(([error]) => error)) throw new Error('Kilter viewer lease update failed');
      const eligible = await this.eligibleViewers(boardId);
      if (board.accountUserId && !eligible.some((account) => account.userId === board.accountUserId))
        board.controller?.abort();
      if (!eligible.length) {
        board.controller?.abort();
        await publisher.eval(RELEASE_OWNER, 1, `kilter-live:${boardId}:owner`, this.owner);
        board.owned = false;
        if (!board.viewers.size) {
          if (board.nextTimer) clearTimeout(board.nextTimer);
          this.boards.delete(boardId);
        }
        return;
      }
      board.owned =
        Number(await publisher.eval(RENEW_OWNER, 1, `kilter-live:${boardId}:owner`, this.owner, LEASE_MS)) === 1;
      if (!board.owned) {
        board.controller?.abort();
        return;
      }
      if (board.controller) return;
      if (board.nextPollAt > Date.now()) {
        this.schedule(boardId, board, board.nextPollAt - Date.now());
        return;
      }
      const nextPoll = Number(await publisher.get(`kilter-live:${boardId}:next`));
      if (nextPoll > Date.now()) {
        this.schedule(boardId, board, nextPoll - Date.now());
        return;
      }
      const controller = new AbortController();
      board.controller = controller;
      board.accountUserId = eligible[0].userId;
      void this.poll(boardId, board, eligible[0], controller).catch(() => {
        logger.warn('[KilterLive] Poll cleanup failed', { boardId });
      });
    } catch (error) {
      board.controller?.abort();
      logger.warn('[KilterLive] Coordination failed', {
        boardId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      board.reconciling = false;
      if (board.rerun && !this.stopped) {
        board.rerun = false;
        void this.reconcile(boardId);
      }
      if (!this.boards.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }
  }

  private async poll(
    boardId: number,
    board: BoardWatch,
    account: { userId: string; linkIdentity: string },
    controller: AbortController,
  ): Promise<void> {
    let delay = 30_000 + Math.floor(Math.random() * 5_001);
    try {
      const wall = await matchKilterWall(boardId);
      if (!wall) {
        // Keep viewer leases alive, but recheck unresolved bindings less often.
        // No credentials or upstream history are requested until a wall matches.
        delay = UNMATCHED_WALL_RETRY_MS;
        return;
      }
      const isCurrent = async (reader: Pick<typeof db, 'select'> = db) => {
        if (controller.signal.aborted || this.stopped || !redisClientManager.isRedisConnected()) return false;
        const owner = await readCoordination(
          redisClientManager.getClients().publisher.get(`kilter-live:${boardId}:owner`),
        );
        if (owner !== this.owner) return false;
        const eligible = await this.eligibleViewers(boardId, reader);
        return eligible.some(
          (viewer) => viewer.userId === account.userId && viewer.linkIdentity === account.linkIdentity,
        );
      };
      if (!(await isCurrent())) return;
      const client = {
        clientId: process.env.KILTER_OAUTH_CLIENT_ID ?? 'kilter',
        clientSecret: process.env.KILTER_OAUTH_CLIENT_SECRET,
      };
      let token = await getStoredKilterAccessToken(db, account.userId, client);
      if (!(await isCurrent())) return;
      const fetchHistory = () => fetchKilterLiveHistory(token, wall, controller.signal);
      const displays = await fetchHistory().catch(async (error: unknown) => {
        if (!(error instanceof KilterLiveError) || error.httpStatus !== 401 || !(await isCurrent())) throw error;
        token = await getStoredKilterAccessToken(db, account.userId, client, true);
        return fetchHistory();
      });
      const currentWall = await matchKilterWall(boardId);
      if (!currentWall || currentWall.sourceKey !== wall.sourceKey || !(await isCurrent())) return;
      const imported = await importKilterDisplays(wall, displays, isCurrent);
      board.failures = 0;
      logger.debug('[KilterLive] Poll completed', { boardId, received: displays.length, imported });
    } catch (error) {
      if (!controller.signal.aborted) {
        board.failures++;
        delay = Math.min(300_000, 30_000 * 2 ** Math.min(board.failures, 4));
        if (error instanceof KilterLiveError) delay = Math.max(delay, error.retryAfterMs);
        if (
          error instanceof KilterApiError &&
          (error.code === 'invalid_grant' || error.httpStatus === 401 || error.httpStatus === 403)
        ) {
          this.rejectedAccounts.set(account.userId, {
            linkIdentity: account.linkIdentity,
            until: Date.now() + 300_000,
          });
          delay = 0;
        }
        logger.warn('[KilterLive] Poll failed', {
          boardId,
          status: error instanceof KilterApiError ? error.httpStatus : undefined,
          kind: error instanceof KilterApiError ? error.code : 'unavailable',
          retryInMs: delay,
        });
      }
    } finally {
      board.nextPollAt = Date.now() + delay;
      try {
        if (redisClientManager.isRedisConnected()) {
          const publisher = redisClientManager.getClients().publisher;
          await publisher.eval(
            SAVE_NEXT,
            2,
            `kilter-live:${boardId}:owner`,
            `kilter-live:${boardId}:next`,
            this.owner,
            String(board.nextPollAt),
            Math.max(LEASE_MS, delay + LEASE_MS),
          );
        }
      } catch {
        /* expired ownership safely hands polling to another instance */
      }
      board.controller = null;
      board.accountUserId = null;
      this.schedule(boardId, board, delay);
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const [boardId, board] of this.boards) {
      board.controller?.abort();
      if (board.nextTimer) clearTimeout(board.nextTimer);
      if (redisClientManager.isRedisConnected()) {
        const publisher = redisClientManager.getClients().publisher;
        const members = [...board.viewers.values()].map((viewer) => viewer.member);
        if (members.length) await publisher.zrem(`kilter-live:${boardId}:viewers`, ...members);
        await publisher.eval(RELEASE_OWNER, 1, `kilter-live:${boardId}:owner`, this.owner);
      }
    }
    if (this.controlSubscribed && redisClientManager.isRedisConnected()) {
      const subscriber = redisClientManager.getClients().subscriber;
      subscriber.off('message', this.onControl);
      await subscriber.unsubscribe(CONTROL_CHANNEL);
    }
    this.boards.clear();
  }
}

export const kilterLiveSync = new KilterLiveSync();
