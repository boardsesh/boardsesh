import type {
  ConnectionContext,
  MoonBoardCollectionImportResult,
  MoonBoardCollectionPreview,
} from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { importMoonBoardCollection, previewMoonBoardCollection } from '../../../services/moonboard-collection';
import {
  MoonBoardCollectionImportInputSchema,
  MoonBoardCollectionPreviewInputSchema,
} from '../../../validation/schemas/moonboard-collection';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';

export const moonBoardCollectionQueries = {
  previewMoonBoardCollectionImport: async (
    _parent: unknown,
    { input }: { input: unknown },
    context: ConnectionContext,
  ): Promise<MoonBoardCollectionPreview> => {
    requireAuthenticated(context);
    await applyRateLimit(context, 30, 'moonboard-collection-preview');
    return previewMoonBoardCollection(db, validateInput(MoonBoardCollectionPreviewInputSchema, input, 'input'));
  },
};

export const moonBoardCollectionMutations = {
  importMoonBoardCollection: async (
    _parent: unknown,
    { input }: { input: unknown },
    context: ConnectionContext,
  ): Promise<MoonBoardCollectionImportResult> => {
    requireAuthenticated(context);
    await applyRateLimit(context, 10, 'moonboard-collection-import');
    return importMoonBoardCollection(
      db,
      context.userId!,
      validateInput(MoonBoardCollectionImportInputSchema, input, 'input'),
    );
  },
};
