import type { AuroraCredentialStatus } from '@boardsesh/shared-schema';
import type { AuroraCredentialStatus as RestAuroraCredentialStatus } from '../../../services/aurora-credentials';

/** The GraphQL shape of a stored board credential's status. */
export function mapAuroraCredentialStatus(credential: RestAuroraCredentialStatus): AuroraCredentialStatus {
  return {
    boardType: credential.boardType,
    username: credential.auroraUsername,
    userId: credential.auroraUserId ?? undefined,
    syncedAt: credential.lastSyncAt ?? undefined,
    hasToken: credential.syncStatus !== 'linked',
    syncStatus: credential.syncStatus,
    syncError: credential.syncError,
    pendingRunId: credential.pendingRunId,
    syncAvailable: credential.syncAvailable,
  };
}
