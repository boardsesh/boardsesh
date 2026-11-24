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
import { LiveHistoryPoller, readLiveCoordination, type LiveHistoryAccount } from './live-history-poller';

export class KilterLiveSync extends LiveHistoryPoller<LiveHistoryAccount> {
  protected readonly namespace = 'kilter-live';
  protected readonly logPrefix = '[KilterLive]';
  protected enabled(): boolean {
    return process.env.KILTER_LIVE_SYNC_ENABLED === '1';
  }
  protected async eligibleViewers(boardId: number, reader: Pick<typeof db, 'select'> = db) {
    const publisher = redisClientManager.getClients().publisher;
    const members = await readLiveCoordination(
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
    return credentials.map((credential) => ({
      userId: credential.userId,
      linkIdentity: `${credential.kilterId}:${credential.linkedAt.toISOString()}`,
    }));
  }

  protected async readHistory(
    boardId: number,
    account: LiveHistoryAccount,
    signal: AbortSignal,
    isCurrent: (reader?: Pick<typeof db, 'select'>) => Promise<boolean>,
  ): Promise<number | void> {
    const wall = await matchKilterWall(boardId);
    if (!wall) {
      // Keep viewer leases alive, but recheck unresolved bindings less often.
      // No credentials or upstream history are requested until a wall matches.
      return 300_000;
    }
    if (!(await isCurrent())) return;
    const client = {
      clientId: process.env.KILTER_OAUTH_CLIENT_ID ?? 'kilter',
      clientSecret: process.env.KILTER_OAUTH_CLIENT_SECRET,
    };
    let token = await getStoredKilterAccessToken(db, account.userId, client);
    if (!(await isCurrent())) return;
    const fetchHistory = () => fetchKilterLiveHistory(token, wall, signal);
    const displays = await fetchHistory().catch(async (error: unknown) => {
      if (!(error instanceof KilterLiveError) || error.httpStatus !== 401 || !(await isCurrent())) throw error;
      token = await getStoredKilterAccessToken(db, account.userId, client, true);
      return fetchHistory();
    });
    const currentWall = await matchKilterWall(boardId);
    if (!currentWall || currentWall.sourceKey !== wall.sourceKey || !(await isCurrent())) return;
    const imported = await importKilterDisplays(wall, displays, isCurrent);
    logger.debug('[KilterLive] Poll completed', { boardId, received: displays.length, imported });
  }
  protected classifyFailure(error: unknown) {
    return {
      retryAfterMs: error instanceof KilterLiveError ? error.retryAfterMs : 0,
      rejectAccount:
        error instanceof KilterApiError &&
        (error.code === 'invalid_grant' || error.httpStatus === 401 || error.httpStatus === 403),
      rejectAccountGlobally: error instanceof KilterApiError && error.code === 'invalid_grant',
      status: error instanceof KilterApiError ? error.httpStatus : undefined,
      kind: error instanceof KilterApiError ? error.code : 'unavailable',
    };
  }
}
export const kilterLiveSync = new KilterLiveSync();
