import {
  acknowledgeOfflineWriteObservations,
  getLocalUserId,
  isBackgrounded,
  isSigningOut,
  readOfflineWriteObservations,
  readOfflineWriteReconciliationCandidates,
  reconcileOfflineWrite,
  touchOfflineWriteObservations,
  type GraphQLFetch,
  type OfflineDatabase,
} from '@boardsesh/offline-sync';
import type { OfflineWriteRelease } from '@boardsesh/shared-schema';

// Keep the transport independent of native modules so restart and account races
// can be verified with the real SQLite journal in node.
import { RECORD_OFFLINE_WRITE_OBSERVATIONS } from '@boardsesh/graphql/operations/offline-write-delivery';

type Receipt = {
  deliveryId: string;
  revision: number;
  serverAcceptedAt: string | null;
  serverRejectedAt: string | null;
};
type ReconciliationCandidate = Awaited<ReturnType<typeof readOfflineWriteReconciliationCandidates>>[number];

export type OfflineWritePublicationOptions = {
  ownerUserId: string;
  isCurrent: () => boolean;
  observedRelease: OfflineWriteRelease;
  verifyLocalState: (candidate: ReconciliationCandidate) => Promise<boolean>;
};

const publications = new WeakMap<OfflineDatabase, Promise<void>>();

/** One bounded page per trigger; upload failure never enters the mutation retry classifier. */
export function publishOfflineWriteDelivery(
  db: OfflineDatabase,
  graphqlFetch: GraphQLFetch,
  options: OfflineWritePublicationOptions,
): Promise<void> {
  const running = publications.get(db);
  if (running) return running;
  const publish = async () => {
    const current = () => options.isCurrent() && !isSigningOut() && !isBackgrounded();
    const ownsDatabase = async () => current() && (await getLocalUserId(db)) === options.ownerUserId && current();
    if (!(await ownsDatabase())) return;
    const candidates = await readOfflineWriteReconciliationCandidates(db, 100);
    for (const candidate of candidates) {
      if (!(await ownsDatabase())) return;
      try {
        if (await options.verifyLocalState(candidate)) {
          if (!(await ownsDatabase())) return;
          await reconcileOfflineWrite(db, candidate.deliveryId);
        }
      } catch (error) {
        // A failed local check must not hide this write's denominator or the
        // remaining writes. Its persisted state still says unreconciled.
        if (__DEV__) console.warn('[OfflineWriteDelivery] local proof deferred', error);
      }
    }
    if (!(await ownsDatabase())) return;
    await touchOfflineWriteObservations(db, 100);
    if (!(await ownsDatabase())) return;
    const observations = await readOfflineWriteObservations(db, 100);
    if (observations.length === 0 || !(await ownsDatabase())) return;
    const response = await graphqlFetch<{ recordOfflineWriteObservations: { receipts: Receipt[] } }>(
      RECORD_OFFLINE_WRITE_OBSERVATIONS,
      {
        input: {
          ownerUserId: options.ownerUserId,
          observations: observations.map((observation) => ({
            ...observation,
            observedRelease: options.observedRelease,
          })),
        },
      },
    );
    if (!(await ownsDatabase())) return;
    const requested = new Map(observations.map((observation) => [observation.deliveryId, observation.revision]));
    // An empty or malformed result is an unacknowledged upload, never success.
    const receipts = response?.recordOfflineWriteObservations?.receipts;
    if (!Array.isArray(receipts)) return;
    await acknowledgeOfflineWriteObservations(
      db,
      receipts.filter((receipt) => requested.get(receipt.deliveryId) === receipt.revision),
    );
  };
  const publication = publish()
    .catch((error: unknown) => {
      if (__DEV__) console.warn('[OfflineWriteDelivery] publication deferred', error);
    })
    .finally(() => {
      if (publications.get(db) === publication) publications.delete(db);
    });
  publications.set(db, publication);
  return publication;
}
