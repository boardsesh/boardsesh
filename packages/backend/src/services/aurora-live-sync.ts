import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { auroraCredentials, providerSyncControls, userBoards } from '@boardsesh/db/schema';
import { fetchAuroraLiveHistory, isAuroraRequestError } from '@boardsesh/aurora-sync/api';
import { db } from '../db/client';
import { redisClientManager } from '../redis/client';
import { logger } from '../utils/logger';
import { LiveHistoryPoller, readLiveCoordination, type LiveHistoryAccount } from './live-history-poller';
import {
  AuroraLiveCredentialChangedError,
  getAuroraLiveToken,
  isAuroraLiveBoardName,
  type AuroraLiveBoardName,
  type AuroraLiveCredentialBinding,
} from './aurora-live-token';
import { importAuroraDisplays, matchAuroraWall, sameAuroraWall } from './aurora-live-import';
import { catchUpAuroraHistory, parseAuroraCheckpoint } from './aurora-live-catchup';

export function isAuroraLiveEnabled(boardType: string): boardType is AuroraLiveBoardName {
  return (
    process.env.AURORA_LIVE_SYNC_ENABLED === '1' &&
    isAuroraLiveBoardName(boardType) &&
    (process.env.AURORA_LIVE_SYNC_BOARDS ?? '').split(',').some((entry) => entry.trim() === boardType)
  );
}
export class AuroraLiveReadStaleError extends Error {
  constructor() {
    super('Aurora live read is no longer current');
    this.name = 'AuroraLiveReadStaleError';
  }
}
type AuroraViewer = LiveHistoryAccount & AuroraLiveCredentialBinding & { boardType: AuroraLiveBoardName };

export class AuroraLiveSync extends LiveHistoryPoller<AuroraViewer> {
  protected readonly namespace = 'aurora-live';
  protected readonly logPrefix = '[AuroraLive]';
  protected enabled(): boolean {
    return process.env.AURORA_LIVE_SYNC_ENABLED === '1';
  }

  protected async eligibleViewers(boardId: number, reader: Pick<typeof db, 'select'> = db): Promise<AuroraViewer[]> {
    const [board] = await reader
      .select({ boardType: userBoards.boardType })
      .from(userBoards)
      .where(eq(userBoards.id, boardId))
      .limit(1);
    if (!board || !isAuroraLiveEnabled(board.boardType)) return [];
    const boardType = board.boardType;
    const members = await readLiveCoordination(
      redisClientManager.getClients().publisher.zrangebyscore(`aurora-live:${boardId}:viewers`, Date.now(), '+inf'),
    );
    const userIds = new Set<string>();
    for (const member of members) {
      try {
        const parsed: unknown = JSON.parse(member);
        if (Array.isArray(parsed) && typeof parsed[0] === 'string') userIds.add(parsed[0]);
      } catch {
        /* Invalid leases cannot authorize upstream access. */
      }
    }
    if (!userIds.size) return [];
    const credentials = await reader
      .select({
        userId: auroraCredentials.userId,
        credentialId: auroraCredentials.id,
        upstreamUserId: auroraCredentials.auroraUserId,
        linkGeneration: providerSyncControls.linkGeneration,
      })
      .from(auroraCredentials)
      .leftJoin(
        providerSyncControls,
        and(
          eq(providerSyncControls.userId, auroraCredentials.userId),
          eq(providerSyncControls.boardType, auroraCredentials.boardType),
        ),
      )
      .where(
        and(
          inArray(auroraCredentials.userId, [...userIds]),
          eq(auroraCredentials.boardType, boardType),
          isNotNull(auroraCredentials.auroraUserId),
          isNotNull(auroraCredentials.encryptedUsername),
          isNotNull(auroraCredentials.encryptedPassword),
          inArray(auroraCredentials.syncStatus, ['pending', 'active', 'error']),
          or(isNull(providerSyncControls.userId), eq(providerSyncControls.linked, true)),
        ),
      );
    return credentials.flatMap((credential) =>
      credential.upstreamUserId === null
        ? []
        : [
            {
              ...credential,
              upstreamUserId: credential.upstreamUserId,
              boardType,
              linkIdentity: `${credential.credentialId}:${credential.upstreamUserId}:${credential.linkGeneration ?? 'legacy'}`,
            },
          ],
    );
  }

  protected async readHistory(
    boardId: number,
    account: AuroraViewer,
    signal: AbortSignal,
    isCurrent: (reader?: Pick<typeof db, 'select'>) => Promise<boolean>,
  ): Promise<number | void> {
    const wall = await matchAuroraWall(boardId);
    if (!wall || wall.boardType !== account.boardType || !isAuroraLiveEnabled(wall.boardType)) return 300_000;
    if (!(await isCurrent())) return;
    let token = await getAuroraLiveToken(account.userId, wall.boardType, account, signal);
    let refreshed = false;
    const fetchPage = async (before?: string) => {
      signal.throwIfAborted();
      if (!(await isCurrent())) throw new AuroraLiveReadStaleError();
      const request = () => fetchAuroraLiveHistory(wall.boardType, wall.serialNumber, token, { before, signal });
      return request().catch(async (error: unknown) => {
        if (refreshed || !isAuroraRequestError(error) || error.status !== 401) throw error;
        if (!(await isCurrent())) throw new AuroraLiveReadStaleError();
        refreshed = true;
        token = await getAuroraLiveToken(account.userId, wall.boardType, account, signal, token);
        if (!(await isCurrent())) throw new AuroraLiveReadStaleError();
        return request();
      });
    };
    const binding = JSON.stringify([
      wall.boardType,
      wall.sourceKey,
      wall.wallUuid,
      wall.serialNumber,
      wall.layoutId,
      wall.sizeId,
      wall.setIds,
    ]);
    const checkpoint = parseAuroraCheckpoint(await this.readCheckpoint(boardId), binding);
    let imported = 0;
    const next = await catchUpAuroraHistory({
      checkpoint,
      fetchPage,
      isCurrent: async () => (await isCurrent()) && sameAuroraWall(wall, await matchAuroraWall(boardId)),
      importPage: async (displays) => {
        imported += await importAuroraDisplays(wall, displays, isCurrent);
      },
      onGap: () => logger.warn('[AuroraLive] Catch-up remains incomplete', { boardId, boardType: wall.boardType }),
    }).catch((error: unknown) => {
      if (error instanceof AuroraLiveReadStaleError) return null;
      throw error;
    });
    if (next && (await isCurrent()) && sameAuroraWall(wall, await matchAuroraWall(boardId))) {
      await this.saveCheckpoint(boardId, JSON.stringify(next));
    }
    logger.debug('[AuroraLive] Poll completed', { boardId, boardType: wall.boardType, imported });
  }

  protected classifyFailure(error: unknown) {
    return {
      retryAfterMs: isAuroraRequestError(error) ? error.retryAfterMs : 0,
      rejectAccount:
        error instanceof AuroraLiveCredentialChangedError ||
        (isAuroraRequestError(error) &&
          (error.code === 'invalid_credentials' || error.status === 401 || error.status === 403)),
      status: isAuroraRequestError(error) ? error.status : undefined,
      kind: isAuroraRequestError(error) ? error.code : 'unavailable',
    };
  }
}
export const auroraLiveSync = new AuroraLiveSync();
