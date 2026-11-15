import { GraphQLError } from 'graphql';
import { z } from 'zod';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import {
  submitCncComputation,
  readCncComputation,
  type CncComputationAssets,
} from '../../../services/cnc/computations';
import { getOwnedArtAssets } from '../../../services/cnc/art-assets';
import { requireCncCreationAccess } from '../../../services/cnc/release-access';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { artworkAssetIds, resolveArtworkAssets, resolveCncConfig } from './config';
import { toGraphQLWorkerError } from './queries';

function unavailable(): GraphQLError {
  return new GraphQLError('The build-pack service is unavailable right now. Try again in a minute.', {
    extensions: { code: 'CNC_WORKER_UNAVAILABLE' },
  });
}
export const cncComputationMutations = {
  requestCncLayout: async (
    _: unknown,
    { config, includeHoles = false }: { config: unknown; includeHoles?: boolean | null },
    context: ConnectionContext,
  ) => {
    const wantsHoles = includeHoles ?? false;
    if (wantsHoles) {
      requireAuthenticated(context);
      requireCncCreationAccess(context.userId!);
    }
    await applyRateLimit(context, wantsHoles ? 10 : 30, 'requestCncLayout');
    try {
      const { layoutRequest } = resolveCncConfig(config);
      return await submitCncComputation({
        operation: 'layout',
        ownerId: wantsHoles ? context.userId! : null,
        request: { layoutRequest, includeHoles: wantsHoles },
      });
    } catch (error) {
      if (error instanceof GraphQLError) throw error;
      if (error instanceof Error && error.message === 'CNC_WORKER_UNAVAILABLE') throw unavailable();
      throw toGraphQLWorkerError(error);
    }
  },
  requestCncArtworkValidation: async (_: unknown, { config }: { config: unknown }, context: ConnectionContext) => {
    requireAuthenticated(context);
    requireCncCreationAccess(context.userId!);
    await applyRateLimit(context, 60, 'requestCncArtworkValidation');
    try {
      const { layoutRequest, artwork, artworkInput } = resolveCncConfig(config);
      await resolveArtworkAssets(context.userId!, artworkInput);
      const owned = await getOwnedArtAssets(context.userId!, artworkAssetIds(artworkInput));
      const assetKeys: CncComputationAssets = {};
      for (const [assetId, asset] of owned)
        assetKeys[assetId] = { key: asset.key, mime: asset.mime, sha256: asset.sha256 };
      return await submitCncComputation({
        operation: 'artwork',
        ownerId: context.userId!,
        request: { layoutRequest, artwork },
        assetKeys,
      });
    } catch (error) {
      if (error instanceof GraphQLError) throw error;
      if (error instanceof Error && error.message === 'CNC_WORKER_UNAVAILABLE') throw unavailable();
      throw toGraphQLWorkerError(error);
    }
  },
};
export const cncComputationQueries = {
  cncComputation: async (_: unknown, { id }: { id: unknown }, context: ConnectionContext) => {
    const requestId = validateInput(z.string().uuid(), id, 'id');
    await applyRateLimit(context, 150, 'cncComputation');
    return readCncComputation(requestId, context.isAuthenticated ? (context.userId ?? null) : null);
  },
};
