import { GraphQLError } from 'graphql';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { ExistingWallCandidatesInputSchema } from '../../../validation/schemas';
import { enrichBoards } from './boards';
import { resolveCanonicalGymByUuid, userCanEditGym } from './gyms';
import { collectWallScope, readWallCandidates } from './existing-wall-check';

const DEFAULT_CANDIDATE_LIMIT = 20;

export const socialBoardWallCandidateQueries = {
  /**
   * Walls that may already be the one a climber is about to add at a gym
   * (#8151). Auth-optional so a signed-out climber can browse a gym's walls
   * before signing in to add one. See existing-wall-check.ts for the scope and
   * the visibility rule, which createBoard's recheck shares.
   *
   * Errors are thrown, never answered with an empty list: the app treats "no
   * walls" as "go ahead and add yours", so a failed lookup must not look like one.
   */
  existingWallCandidates: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    await applyRateLimit(ctx, 20, 'existingWallCandidates');
    const validatedInput = validateInput(ExistingWallCandidatesInputSchema, input, 'input');
    const viewerId = ctx.isAuthenticated ? ctx.userId : undefined;

    // A merged listing's uuid resolves to the gym it merged into. A private gym
    // the viewer can't edit is masked as missing, like `gymBoards`.
    const gym = await resolveCanonicalGymByUuid(validatedInput.gymUuid);
    const canSeeGym = gym != null && (gym.isPublic || (viewerId != null && (await userCanEditGym(gym, viewerId))));
    if (!gym || !canSeeGym) {
      throw new GraphQLError('Gym not found', { extensions: { code: 'NOT_FOUND' } });
    }

    const draft =
      validatedInput.layoutId != null && validatedInput.sizeId != null && validatedInput.setIds != null
        ? {
            boardType: validatedInput.boardType,
            layoutId: validatedInput.layoutId,
            sizeId: validatedInput.sizeId,
            setIds: validatedInput.setIds,
          }
        : null;

    const scope = await collectWallScope({ kind: 'gym', gym });
    const { candidates, rowCapReached } = await readWallCandidates({
      scope,
      boardType: validatedInput.boardType,
      viewerId,
      draft,
    });

    const limit = validatedInput.limit ?? DEFAULT_CANDIDATE_LIMIT;
    const returned = candidates.slice(0, limit);
    // Enrichment runs the same per-board read rules as every other board list;
    // `allowUnlistedLink: false` because listing a gym is not holding a link.
    const enriched = await enrichBoards(
      returned.map((candidate) => ({ board: candidate.board })),
      viewerId,
      { allowUnlistedLink: false },
    );
    const enrichedByUuid = new Map(enriched.map((board) => [board.uuid, board]));

    return {
      candidates: returned.flatMap((candidate) => {
        const board = enrichedByUuid.get(candidate.board.uuid);
        if (!board) return [];
        return [
          {
            board,
            matchKind: candidate.matchKind,
            missingSetIds: candidate.missingSetIds,
            extraSetIds: candidate.extraSetIds,
            source: candidate.source,
            gymName: candidate.gymName,
            gymDistanceMeters: candidate.gymDistanceMeters,
          },
        ];
      }),
      truncated: rowCapReached || candidates.length > limit,
    };
  },
};
