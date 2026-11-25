import { eq } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import * as dbSchema from '@boardsesh/db/schema';
import {
  keepLedLinksFromOlderApp,
  keepLedPairsFromOlderApp,
  readTnutLayout,
  type TnutLayout,
} from '@boardsesh/spray-wall-geometry';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { SaveSprayWallLedSetupInputSchema } from '../../../validation/schemas/spray-walls';
import { UUIDSchema } from '../../../validation/schemas/primitives';
import { sprayBoardRowIsReadable } from '../climbs/spray-read-access';
import { canEditBoard } from '../social/boards';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { SPRAY_WALL_CODES, loadWall, sprayWallArchivedError } from './spray-walls';

/**
 * A spray wall's LED setup: on the server so every climber at the wall can light
 * it, keyed on `user_boards.id` so it stays out of the account-deletion and
 * user-reference catalogs.
 *
 * The server stores this and does nothing else with it. It never contacts the
 * controller: requests go from the phone over the local network.
 *
 * Reads need an account and the wall's own rule (`sprayBoardRowIsReadable` with
 * the uuid as a capability, the check behind `sprayWall(uuid)`), which keeps LAN
 * addresses away from anonymous callers. Signed out is an error, not null: the
 * phone reads null as "access withdrawn" and erases its copy, which a token
 * hiccup must not do. Writes follow Edit board (`canEditBoard`). Both read the
 * primary: the phone compares the answer with what it just uploaded, so a
 * lagging replica would show as a change and blank the wall.
 */

const READ_RATE_LIMIT = 60;
/**
 * The setup screen saves on every step, and a climber can tap Next quickly.
 * The phone coalesces per wall, so this ceiling is well above any real use.
 */
const SAVE_RATE_LIMIT = 120;

export const SPRAY_WALL_LED_EDIT_DENIED_CODE = 'SPRAY_WALL_LED_EDIT_DENIED';
export const SPRAY_WALL_LED_STRIPE_UPGRADE_REQUIRED_CODE = 'SPRAY_WALL_LED_STRIPE_UPGRADE_REQUIRED';

type LedSetupRow = typeof dbSchema.sprayWallLedSetups.$inferSelect;

function notFound(): GraphQLError {
  return new GraphQLError('Spray wall not found', { extensions: { code: SPRAY_WALL_CODES.notFound } });
}

function toGraphQLSetup(row: LedSetupRow, boardUuid: string) {
  return {
    boardUuid,
    controllerType: row.controllerType,
    controllerUrl: row.controllerUrl,
    enabled: row.enabled,
    brightness: row.brightness,
    autoOffMinutes: row.autoOffMinutes,
    layout: row.layout,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const sprayWallLedSetupQueries = {
  sprayWallLedSetup: async (_: unknown, { boardUuid }: { boardUuid: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, READ_RATE_LIMIT, 'sprayWallLedSetup');
    const validatedUuid = validateInput(UUIDSchema, boardUuid, 'boardUuid');
    // Joined to the wall, so this is null for every board that is not a spray wall.
    const loaded = await loadWall('uuid', validatedUuid);
    if (!loaded) return null;
    const { wall, board } = loaded;
    if (!(await sprayBoardRowIsReadable(board, ctx.userId, 'capability', db))) return null;

    const [row] = await db
      .select()
      .from(dbSchema.sprayWallLedSetups)
      .where(eq(dbSchema.sprayWallLedSetups.boardId, board.id))
      .limit(1);

    return {
      viewerCanEdit: wall.archivedAt == null && (await canEditBoard(ctx.userId!, board)),
      setup: row ? toGraphQLSetup(row, board.uuid) : null,
    };
  },
};

export const sprayWallLedSetupMutations = {
  saveSprayWallLedSetup: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, SAVE_RATE_LIMIT, 'saveSprayWallLedSetup');
    const { boardUuid, controllerType, controllerUrl, enabled, brightness, autoOffMinutes, layout } = validateInput(
      SaveSprayWallLedSetupInputSchema,
      input,
      'input',
    );

    const loaded = await loadWall('uuid', boardUuid);
    if (!loaded) throw notFound();
    const { wall, board } = loaded;
    if (!(await canEditBoard(ctx.userId!, board))) {
      // Whether someone else's wall exists is only worth telling a viewer who can see it.
      if (!(await sprayBoardRowIsReadable(board, ctx.userId, 'capability', db))) throw notFound();
      throw new GraphQLError('Only someone who can edit this wall can change its LED setup.', {
        extensions: { code: SPRAY_WALL_LED_EDIT_DENIED_CODE },
      });
    }
    if (wall.archivedAt != null) throw sprayWallArchivedError();

    const sentLayout = (input as { layout?: unknown } | null)?.layout;
    const sentPairs = typeof sentLayout === 'object' && sentLayout !== null && 'ledGroups' in sentLayout;
    const sentTnutLinks = typeof sentLayout === 'object' && sentLayout !== null && 'tnutLeds' in sentLayout;
    const sentUpperLinks = typeof sentLayout === 'object' && sentLayout !== null && 'holdAboveLeds' in sentLayout;
    const sentStripes = typeof sentLayout === 'object' && sentLayout !== null && 'ledStripes' in sentLayout;
    return db.transaction(async (transaction) => {
      // Lock the stable parent even before the first setup exists. All writers
      // share the lock, so an older client cannot read stale modern links and
      // overwrite a newer save between this merge and the upsert.
      await transaction
        .select({ id: dbSchema.userBoards.id })
        .from(dbSchema.userBoards)
        .where(eq(dbSchema.userBoards.id, board.id))
        .for('update');
      let savedLayout: TnutLayout | null | undefined = layout;
      if (layout != null && (!sentPairs || !sentTnutLinks || !sentUpperLinks || !sentStripes)) {
        const [stored] = await transaction
          .select({ layout: dbSchema.sprayWallLedSetups.layout })
          .from(dbSchema.sprayWallLedSetups)
          .where(eq(dbSchema.sprayWallLedSetups.boardId, board.id))
          .limit(1);
        if (!sentStripes && stored?.layout?.ledPlacement === 'stripe') {
          throw new GraphQLError('Update Boardsesh before changing the LED setup of a wall using LED stripes.', {
            extensions: { code: SPRAY_WALL_LED_STRIPE_UPGRADE_REQUIRED_CODE },
          });
        }
        const storedLayout = stored?.layout ? readTnutLayout(stored.layout) : null;
        savedLayout = keepLedLinksFromOlderApp(
          keepLedPairsFromOlderApp(layout, sentPairs, storedLayout),
          { tnutLeds: sentTnutLinks, holdAboveLeds: sentUpperLinks },
          storedLayout,
        );
      }

      const now = new Date();
      const fields = {
        updatedAt: now,
        ...(controllerType != null ? { controllerType } : controllerUrl != null ? { controllerType: 'wled' } : {}),
        ...(controllerUrl != null ? { controllerUrl } : {}),
        ...(enabled != null ? { enabled } : {}),
        ...(brightness != null ? { brightness } : {}),
        ...(autoOffMinutes != null ? { autoOffMinutes } : {}),
        ...(savedLayout != null ? { layout: savedLayout as unknown as Record<string, unknown> } : {}),
      };
      const [row] = await transaction
        .insert(dbSchema.sprayWallLedSetups)
        .values({ boardId: board.id, ...fields })
        .onConflictDoUpdate({ target: dbSchema.sprayWallLedSetups.boardId, set: fields })
        .returning();
      return toGraphQLSetup(row, board.uuid);
    });
  },
};
