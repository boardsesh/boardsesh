/** Private, first-party delivery evidence. Never publish these identities to analytics. */
export const OFFLINE_WRITE_DELIVERY_HEADER = 'x-boardsesh-offline-write-id';
export const OFFLINE_WRITE_RELEASE_HEADER = 'x-boardsesh-offline-write-release';
export const OFFLINE_WRITE_OBSERVATION_BATCH_LIMIT = 100;

export type OfflineWriteConnectivityReason =
  | 'device_offline'
  | 'backend_unreachable'
  | 'offline_mode'
  | 'online'
  | 'unknown';

export type OfflineWriteState = 'pending' | 'dead_letter' | 'finalized' | 'reconciled' | 'superseded' | 'discarded';

export type OfflineWriteRelease = {
  applicationId: string | null;
  platform: 'ios' | 'android' | 'unknown';
  appVersion: string | null;
  runtimeVersion: string | null;
  updateId: string | null;
  isEmbedded: boolean | null;
  branch: string | null;
};

export type OfflineWriteEnqueueContext = {
  deliveryId: string;
  queuedAt: string;
  connectivityReason: OfflineWriteConnectivityReason;
  originRelease: OfflineWriteRelease;
};

export type OfflineWriteObservation = OfflineWriteEnqueueContext & {
  tableName: string;
  operation: 'create' | 'update' | 'delete';
  state: OfflineWriteState;
  observedAt: string;
  revision: number;
  recovered: boolean;
  /** Client response receipt, not authoritative proof of a server commit. */
  serverResponseAt: string | null;
  reconciledAt: string | null;
  firstDeadLetterAt: string | null;
  lastDeadLetterAt: string | null;
  observedRelease?: OfflineWriteRelease;
};

export type OfflineWriteDeliveryReceipt = {
  deliveryId: string;
  revision: number;
  serverAcceptedAt: string | null;
  serverRejectedAt: string | null;
};

export type RecordOfflineWriteObservationsInput = {
  /** Owner captured before the upload starts; the backend checks it against the actual credential. */
  ownerUserId: string;
  observations: OfflineWriteObservation[];
};
export type RecordOfflineWriteObservationsResult = { receipts: OfflineWriteDeliveryReceipt[] };
