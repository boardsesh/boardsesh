import { randomUUID } from 'node:crypto';
import { db } from '../db/client';
import { redisClientManager } from '../redis/client';
import { logger } from '../utils/logger';

const HEARTBEAT_MS = 15_000;
const LEASE_MS = 60_000;
const COORDINATION_READ_TIMEOUT_MS = 1_000;
const RENEW_OWNER = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2]); return 1 end
  if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return 1 end return 0`;
const RELEASE_OWNER = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
// Our Redis client targets standalone Redis. Cluster support would require
// migrating these board keys to a shared hash tag before using this two-key script.
const SAVE_NEXT = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3]) end return 0`;
type Viewer = { userId: string; connectionId: string; member: string };
export type LiveHistoryAccount = { userId: string; linkIdentity: string };
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
  accountLinkIdentity: string | null;
};

export async function readLiveCoordination<Result>(operation: Promise<Result>): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Live history coordination read timed out')),
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
export abstract class LiveHistoryPoller<Account extends LiveHistoryAccount> {
  protected abstract readonly namespace: string;
  protected abstract readonly logPrefix: string;
  protected abstract enabled(): boolean;
  protected abstract eligibleViewers(boardId: number, reader?: Pick<typeof db, 'select'>): Promise<Account[]>;
  protected abstract readHistory(
    boardId: number,
    account: Account,
    signal: AbortSignal,
    isCurrent: (reader?: Pick<typeof db, 'select'>) => Promise<boolean>,
  ): Promise<number | void>;
  protected abstract classifyFailure(error: unknown): {
    retryAfterMs?: number;
    rejectAccount?: boolean;
    rejectAccountGlobally?: boolean;
    status?: number;
    kind?: string;
  };
  private get controlChannel(): string {
    return `boardsesh:${this.namespace}:changed`;
  }
  private key(boardId: number, suffix: string): string {
    return `${this.namespace}:${boardId}:${suffix}`;
  }

  private readonly owner = randomUUID();
  private readonly boards = new Map<number, BoardWatch>();
  private readonly rejectedAccounts = new Map<string, { linkIdentity: string; until: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private controlSubscribed = false;
  private readonly onControl = (channel: string, message: string) => {
    if (channel !== this.controlChannel) return;
    if (message === '*') {
      for (const boardId of this.boards.keys()) void this.reconcile(boardId);
      return;
    }
    const boardId = Number(message);
    if (this.boards.has(boardId)) void this.reconcile(boardId);
  };

  watch(boardId: number, userId: string, connectionId: string): () => void {
    if (!this.enabled() || this.stopped) return () => {};
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
        accountLinkIdentity: null,
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
    if (!this.enabled()) return;
    for (const boardId of this.boards.keys()) void this.reconcile(boardId);
    if (redisClientManager.isRedisConnected())
      await redisClientManager.getClients().publisher.publish(this.controlChannel, '*');
  }

  protected async readCheckpoint(boardId: number): Promise<string | null> {
    return readLiveCoordination(redisClientManager.getClients().publisher.get(this.key(boardId, 'checkpoint')));
  }

  protected async saveCheckpoint(boardId: number, checkpoint: string): Promise<void> {
    await redisClientManager
      .getClients()
      .publisher.eval(
        SAVE_NEXT,
        2,
        this.key(boardId, 'owner'),
        this.key(boardId, 'checkpoint'),
        this.owner,
        checkpoint,
        String(604_800_000),
      );
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
        await publisher.zrem(this.key(boardId, 'viewers'), viewer.member);
        await publisher.publish(this.controlChannel, String(boardId));
      }
      await this.reconcile(boardId);
    } catch (error) {
      board?.controller?.abort();
      logger.warn(`${this.logPrefix} Viewer removal coordination failed`, {
        boardId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private async availableViewers(boardId: number, reader: Pick<typeof db, 'select'> = db): Promise<Account[]> {
    const credentials = await this.eligibleViewers(boardId, reader);
    for (const [key, rejection] of this.rejectedAccounts) {
      if (rejection.until <= Date.now()) this.rejectedAccounts.delete(key);
    }
    return credentials
      .filter((credential) => {
        return [`${boardId}:${credential.userId}`, `account:${credential.userId}`].every((key) => {
          const rejection = this.rejectedAccounts.get(key);
          return !rejection || rejection.linkIdentity !== credential.linkIdentity || rejection.until <= Date.now();
        });
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
          await subscriber.subscribe(this.controlChannel);
        } catch (error) {
          this.controlSubscribed = false;
          subscriber.off('message', this.onControl);
          throw error;
        }
      }
      const viewersKey = this.key(boardId, 'viewers');
      const pipeline = publisher.pipeline().zremrangebyscore(viewersKey, '-inf', Date.now());
      for (const viewer of board.viewers.values()) pipeline.zadd(viewersKey, Date.now() + LEASE_MS, viewer.member);
      pipeline.pexpire(viewersKey, LEASE_MS);
      const results = await pipeline.exec();
      if (!results || results.some(([error]) => error))
        throw new Error(`${this.logPrefix.slice(1, -1).replace('Live', '')} viewer lease update failed`);
      const eligible = await this.availableViewers(boardId);
      if (
        board.accountUserId &&
        !eligible.some(
          (account) => account.userId === board.accountUserId && account.linkIdentity === board.accountLinkIdentity,
        )
      )
        board.controller?.abort();
      if (!eligible.length) {
        board.controller?.abort();
        await publisher.eval(RELEASE_OWNER, 1, this.key(boardId, 'owner'), this.owner);
        board.owned = false;
        if (!board.viewers.size) {
          if (board.nextTimer) clearTimeout(board.nextTimer);
          this.boards.delete(boardId);
        }
        return;
      }
      board.owned =
        Number(await publisher.eval(RENEW_OWNER, 1, this.key(boardId, 'owner'), this.owner, LEASE_MS)) === 1;
      if (!board.owned) {
        board.controller?.abort();
        return;
      }
      if (board.controller) return;
      if (board.nextPollAt > Date.now()) {
        this.schedule(boardId, board, board.nextPollAt - Date.now());
        return;
      }
      const nextPoll = Number(await publisher.get(this.key(boardId, 'next')));
      if (nextPoll > Date.now()) {
        this.schedule(boardId, board, nextPoll - Date.now());
        return;
      }
      const controller = new AbortController();
      board.controller = controller;
      board.accountUserId = eligible[0].userId;
      board.accountLinkIdentity = eligible[0].linkIdentity;
      void this.poll(boardId, board, eligible[0], controller).catch(() => {
        logger.warn(`${this.logPrefix} Poll cleanup failed`, { boardId });
      });
    } catch (error) {
      board.controller?.abort();
      logger.warn(`${this.logPrefix} Coordination failed`, {
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

  private async poll(boardId: number, board: BoardWatch, account: Account, controller: AbortController): Promise<void> {
    let delay = 30_000 + Math.floor(Math.random() * 5_001);
    try {
      const isCurrent = async (reader: Pick<typeof db, 'select'> = db) => {
        if (controller.signal.aborted || this.stopped || !this.enabled() || !redisClientManager.isRedisConnected())
          return false;
        const owner = await readLiveCoordination(
          redisClientManager.getClients().publisher.get(this.key(boardId, 'owner')),
        );
        if (owner !== this.owner) return false;
        const eligible = await this.availableViewers(boardId, reader);
        return eligible.some(
          (viewer) => viewer.userId === account.userId && viewer.linkIdentity === account.linkIdentity,
        );
      };
      if (!(await isCurrent())) return;
      const requestedDelay = await this.readHistory(boardId, account, controller.signal, isCurrent);
      if (requestedDelay !== undefined) delay = requestedDelay;
      board.failures = 0;
    } catch (error) {
      if (!controller.signal.aborted) {
        board.failures++;
        delay = Math.min(300_000, 30_000 * 2 ** Math.min(board.failures, 4));
        const failure = this.classifyFailure(error);
        delay = Math.max(delay, failure.retryAfterMs ?? 0);
        if (failure.rejectAccount) {
          const rejectionKey = failure.rejectAccountGlobally
            ? `account:${account.userId}`
            : `${boardId}:${account.userId}`;
          this.rejectedAccounts.set(rejectionKey, {
            linkIdentity: account.linkIdentity,
            until: Date.now() + 300_000,
          });
          delay = 0;
        }
        logger.warn(`${this.logPrefix} Poll failed`, {
          boardId,
          status: failure.status,
          kind: failure.kind ?? 'unavailable',
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
            this.key(boardId, 'owner'),
            this.key(boardId, 'next'),
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
      board.accountLinkIdentity = null;
      this.schedule(boardId, board, delay);
    }
  }

  stop(): Promise<void> {
    return this.shutdown();
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
        if (members.length) await publisher.zrem(this.key(boardId, 'viewers'), ...members);
        await publisher.eval(RELEASE_OWNER, 1, this.key(boardId, 'owner'), this.owner);
      }
    }
    if (this.controlSubscribed && redisClientManager.isRedisConnected()) {
      const subscriber = redisClientManager.getClients().subscriber;
      subscriber.off('message', this.onControl);
      await subscriber.unsubscribe(this.controlChannel);
    }
    this.boards.clear();
  }
}
