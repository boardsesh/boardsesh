import { and, asc, eq, isNull } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { esp32Controllers, sprayWalls, userBoards } from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { applyRateLimit } from '../shared/helpers';

export type ControllerBoardRow = {
  boardId: number;
  uuid: string;
  name: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  hasLeds: boolean;
};

export const controllerBoardQueries = {
  /**
   * The key owner's own boards, for a wall device's setup screen
   * (docs/wall-devices.md). Without it the owner had nowhere to read a board's
   * id: no screen shows it, and a private wall has no share link.
   *
   * Controller-key only. `controllerId` / `controllerApiKey` are set solely by the
   * WebSocket onConnect after the key validated (HTTP never sets them), so this
   * is WS-only by construction, and a signed-in user without a key is refused:
   * their own boards are already on `myBoards`.
   *
   * Lists only boards the owner OWNS, never boards they merely follow or were
   * granted: the key opens those for reading too, but this is "pick your wall",
   * not a directory of everything the owner can see.
   */
  controllerBoards: async (_: unknown, __: unknown, ctx: ConnectionContext): Promise<ControllerBoardRow[]> => {
    if (!ctx.controllerId || !ctx.controllerApiKey) {
      throw new GraphQLError('Controller authentication required', { extensions: { code: 'UNAUTHENTICATED' } });
    }
    await applyRateLimit(ctx, 60, 'controllerBoards');
    // Re-read the registration rather than trusting the owner stamped at connect,
    // so a controller deleted in Settings stops listing on an open socket too.
    const [controller] = await db
      .select({ userId: esp32Controllers.userId })
      .from(esp32Controllers)
      .where(and(eq(esp32Controllers.id, ctx.controllerId), eq(esp32Controllers.apiKey, ctx.controllerApiKey)))
      .limit(1);
    if (!controller) {
      throw new GraphQLError('Controller authentication required', { extensions: { code: 'UNAUTHENTICATED' } });
    }
    if (!controller.userId) return [];

    const rows = await db
      .select({
        boardId: userBoards.id,
        uuid: userBoards.uuid,
        name: userBoards.name,
        boardType: userBoards.boardType,
        layoutId: userBoards.layoutId,
        sizeId: userBoards.sizeId,
        setIds: userBoards.setIds,
        angle: userBoards.angle,
        hasLeds: userBoards.hasLeds,
      })
      .from(userBoards)
      // A spray wall's board row outlives an archive (a reset's old wall) and its
      // own soft delete; neither is a wall a device should be pointed at.
      .leftJoin(sprayWalls, eq(sprayWalls.boardUuid, userBoards.uuid))
      .where(
        and(
          eq(userBoards.ownerId, controller.userId),
          isNull(userBoards.deletedAt),
          isNull(sprayWalls.archivedAt),
          isNull(sprayWalls.deletedAt),
        ),
      )
      .orderBy(asc(userBoards.name), asc(userBoards.id));

    return rows.map((row) => ({
      ...row,
      boardId: Number(row.boardId),
      layoutId: Number(row.layoutId),
      sizeId: Number(row.sizeId),
      angle: Number(row.angle),
    }));
  },
};
