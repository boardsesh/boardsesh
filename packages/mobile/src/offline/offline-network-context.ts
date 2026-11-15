import type { QueryClient } from '@tanstack/react-query';
import type { CapturedSyncSession, QueryInvalidator } from '@boardsesh/offline-sync';

export type OfflineNetworkContext = Readonly<{
  network: CapturedSyncSession;
  bindInvalidator: (client: QueryClient) => QueryInvalidator;
}>;
export type OfflineNetworkStart = Readonly<{ resolve: () => Promise<OfflineNetworkContext> }>;

/** Native retains its supplied fetch and credential policy. Local enqueue does
 * not ask for a network capability on any platform. */
export function captureOfflineNetworkContext(
  _readLegacyUserId: () => Promise<string | undefined>,
): OfflineNetworkStart | undefined {
  return undefined;
}
