import { and, asc, eq, isNull } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { esp32Controllers, userBoards } from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { BoardSerialSchema } from '../../../validation/schemas/primitives';
import { applyRateLimit, requireControllerAuth } from '../shared/helpers';
import { requireGymOwnerOrAdmin, resolveCanonicalGymBySlug, resolveCanonicalGymByUuid } from '../social/gyms';
import {
  controllerPreviewDescriptor,
  getControllerPreview,
  normalizeControllerPreviewConfig,
} from '../../../services/controller-preview';

type ManifestBoardInput = Pick<
  typeof userBoards.$inferSelect,
  'uuid' | 'name' | 'boardType' | 'serialNumber' | 'layoutId' | 'sizeId' | 'setIds' | 'angle'
>;

/** Validate the complete set before generating any asset or accepting a partial deployment. */
export function validateControllerGymBoards(boards: ManifestBoardInput[]) {
  if (boards.length < 1 || boards.length > 3) throw new Error('Controller gyms must contain one to three boards');
  const serials = new Set<string>();
  const configs = new Set<string>();
  return [...boards]
    .sort((left, right) => left.boardType.localeCompare(right.boardType) || left.uuid.localeCompare(right.uuid))
    .map((board) => {
      const serialNumber = BoardSerialSchema.parse(board.serialNumber);
      const config = normalizeControllerPreviewConfig({
        boardName: board.boardType,
        layoutId: Number(board.layoutId),
        sizeId: Number(board.sizeId),
        setIds: board.setIds,
      });
      const configKey = `${config.boardName}/${config.layoutId}/${config.sizeId}/${config.setIds}`;
      if (serials.has(serialNumber) || configs.has(configKey))
        throw new Error('Controller gym has duplicate serials or configurations');
      serials.add(serialNumber);
      configs.add(configKey);
      const advertisedName =
        config.boardName === 'moonboard'
          ? `MoonBoard A#${serialNumber}`
          : `${config.boardName === 'kilter' ? 'Kilter' : 'Tension'} Board#${serialNumber}@3`;
      // A legacy advertisement/scan-response is 31 bytes including the two-byte
      // AD length/type prefix for its complete local name.
      if (Buffer.byteLength(advertisedName) > 29)
        throw new Error('Controller serial is too long for its Bluetooth advertisement');
      return {
        uuid: board.uuid,
        name: board.name,
        boardType: config.boardName,
        serialNumber,
        layoutId: config.layoutId,
        sizeId: config.sizeId,
        setIds: config.setIds,
        angle: Number(board.angle),
        advertisedName,
        config,
      };
    });
}

export const controllerGymQueries = {
  controllerGymManifest: async (_: unknown, { gymRef }: { gymRef: string }, ctx: ConnectionContext) => {
    if (!ctx.controllerId || !ctx.controllerApiKey) {
      throw new GraphQLError('Controller authentication required', { extensions: { code: 'UNAUTHENTICATED' } });
    }
    const { controllerId, controllerApiKey } = requireControllerAuth(ctx);
    await applyRateLimit(ctx, 20, 'controllerGymManifest');
    const reference = z.string().trim().min(1).max(120).parse(gymRef);
    // Re-read the registration, so revocation takes effect on an existing WS too.
    const [controller] = await db
      .select({ userId: esp32Controllers.userId })
      .from(esp32Controllers)
      .where(and(eq(esp32Controllers.id, controllerId), eq(esp32Controllers.apiKey, controllerApiKey)))
      .limit(1);
    if (!controller?.userId)
      throw new GraphQLError('Registered controller owner required', { extensions: { code: 'FORBIDDEN' } });
    const gym = z.string().uuid().safeParse(reference).success
      ? await resolveCanonicalGymByUuid(reference)
      : await resolveCanonicalGymBySlug(reference);
    if (!gym?.slug) throw new GraphQLError('Gym not found', { extensions: { code: 'NOT_FOUND' } });
    try {
      await requireGymOwnerOrAdmin(gym.uuid, controller.userId);
    } catch (error) {
      if (error instanceof Error && error.message === 'Not authorized: must be gym owner or admin') {
        throw new GraphQLError('Gym owner or admin required', { extensions: { code: 'FORBIDDEN' } });
      }
      // Storage/transport failures must remain retryable, not revoke a valid
      // cached device configuration as if its permission had been withdrawn.
      throw error;
    }
    const rows = await db
      .select()
      .from(userBoards)
      .where(and(eq(userBoards.gymId, gym.id), isNull(userBoards.deletedAt)))
      .orderBy(asc(userBoards.boardType), asc(userBoards.uuid))
      .limit(4);
    let validated;
    try {
      validated = validateControllerGymBoards(rows);
    } catch {
      throw new GraphQLError(
        'Gym must have one to three supported boards with unique serials and valid configurations',
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }
    const boards = [];
    for (const board of validated) {
      const { config, ...fields } = board;
      boards.push({ ...fields, preview: controllerPreviewDescriptor(config, await getControllerPreview(config)) });
    }
    return { version: 1, gymUuid: gym.uuid, name: gym.name, slug: gym.slug, boards };
  },
};
