import { GraphQLError } from 'graphql';
import type { ConnectionContext, UserDataExportFormat } from '@boardsesh/shared-schema';
import { requireAuthenticated } from '../shared/helpers';
import {
  getUserDataExportDownloadLink,
  getUserDataExportStatus,
  isExportBoardType,
  requestUserDataExport,
} from '../../../services/user-data-export';

function exportBoard(boardType: string) {
  if (!isExportBoardType(boardType))
    throw new GraphQLError('Invalid boardType', { extensions: { code: 'BAD_USER_INPUT' } });
  return boardType;
}

export const userDataExportQueries = {
  userDataExport: (
    _: unknown,
    { boardType, period }: { boardType: string; period?: string | null },
    context: ConnectionContext,
  ) => {
    requireAuthenticated(context);
    return getUserDataExportStatus(context.userId!, exportBoard(boardType), period);
  },
  userDataExportDownload: async (
    _: unknown,
    {
      boardType,
      period,
      format,
    }: {
      boardType: string;
      period: string;
      format: UserDataExportFormat;
    },
    context: ConnectionContext,
  ) => {
    requireAuthenticated(context);
    try {
      return await getUserDataExportDownloadLink(context.userId!, exportBoard(boardType), period, format);
    } catch (error) {
      if (error instanceof GraphQLError) throw error;
      throw new GraphQLError('Export service is temporarily unavailable.', {
        extensions: { code: 'SERVICE_UNAVAILABLE' },
      });
    }
  },
};

export const userDataExportMutations = {
  requestUserDataExport: (_: unknown, { boardType }: { boardType: string }, context: ConnectionContext) => {
    requireAuthenticated(context);
    return requestUserDataExport(context.userId!, exportBoard(boardType));
  },
};
