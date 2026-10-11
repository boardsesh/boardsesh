import type { Query, QueryClient } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { sanitizeActiveBoard } from '../active-board-snapshot';
import { reportHandledError } from '../error-reporting';

// Projections of other people's content can carry copied names, avatars,
// notes or prior grants. Cancel first, clear the snapshot, then refetch:
// invalidate alone leaves old protected content visible while a request is in
// flight. Every query root defaults to that treatment; the two sets below are
// the deliberate exceptions, so a new root is withdrawn until someone shows it
// cannot carry another account's privacy-gated data.

// Left alone: the viewer's own data, device-local state, dev tooling and
// static reference data. Nothing in them is gated by someone else's privacy.
const PRIVACY_NEUTRAL_QUERY_ROOTS = new Set([
  // The viewer's own identity, credentials and unsynced work.
  'profile',
  'localPendingTicks',
  'localTicks',
  'wsAuthToken',
  'authToken',
  // Board-type reference data: grade scales, angles and the popular-config rail
  // (aggregate counts; spray walls are excluded from it on the server).
  'grades',
  'angles',
  'popularBoardConfigs',
  // Offline download bookkeeping read from this device. The catalogue
  // withdrawal itself runs through the registered revalidation.
  'snapshotManifest',
  'downloadedScopeKeys',
  'bootstrapMetadataByScope',
  'offlineStorage',
  'offlineReclaimableBytes',
  'deadLetters',
  // Developer and QA tooling.
  'dev',
  'dev-bundlers',
  'saved-metro-targets',
  'qaBranches',
  'qaPreviews',
]);

// Refetched but not blanked while on screen: climb search lists. A private
// account's followers-only climbs are filtered per viewer, so a revocation must
// reach them, but clearing them would empty the main climb list on every launch
// for a change that rarely touches it. One that is off screen is withdrawn like
// any other query: invalidation only refetches what is on screen, so it would
// otherwise come back with its old rows. A spray wall's search stays fully
// withdrawn: the whole wall's catalogue sits behind its privacy.
const CATALOGUE_SEARCH_QUERY_ROOTS = new Set(['searchClimbs', 'infiniteSearchClimbs', 'searchClimbsCount']);

type PrivacyQueryTreatment = 'keep' | 'refetch' | 'withdraw';

/**
 * The board a climb search key searches, from whichever key element carries the
 * search input. Null when no element names a board, so a reshaped key fails
 * closed instead of passing a spray wall's search off as a catalogue one.
 */
function searchedBoardName(queryKey: readonly unknown[]): string | null {
  for (const part of queryKey.slice(1)) {
    if (typeof part === 'object' && part !== null && 'boardName' in part && typeof part.boardName === 'string') {
      return part.boardName;
    }
  }
  return null;
}

/** How a privacy event treats a cached query, decided by its key. */
export function privacyQueryTreatment(queryKey: readonly unknown[]): PrivacyQueryTreatment {
  const root = String(queryKey[0]);
  if (PRIVACY_NEUTRAL_QUERY_ROOTS.has(root)) return 'keep';
  if (CATALOGUE_SEARCH_QUERY_ROOTS.has(root)) {
    const boardName = searchedBoardName(queryKey);
    if (boardName !== null && boardName !== 'spray') return 'refetch';
  }
  return 'withdraw';
}

let privacyRevocationGeneration = 0;
let privacyCredentialGeneration = 0;
const revocationListeners = new Set<() => void>();

export const getPrivacyCredentialGeneration = (): number => privacyCredentialGeneration;

export const getPrivacyRevocationGeneration = (): number => privacyRevocationGeneration;

export function subscribeToPrivacyRevocations(listener: () => void): () => void {
  revocationListeners.add(listener);
  return () => {
    revocationListeners.delete(listener);
  };
}

let revalidatePrivacy: (() => Promise<void>) | undefined;

/** Installed by the authenticated bridge; ownership-safe across effect replacement. */
export function registerPrivacyRevalidation(handler: () => Promise<void>): () => void {
  revalidatePrivacy = handler;
  return () => {
    if (revalidatePrivacy === handler) revalidatePrivacy = undefined;
  };
}

/** Also used at credential boundaries, before asynchronous credential storage. */
export function invalidatePrivacySnapshots(reason: 'privacy' | 'credential' = 'privacy'): void {
  if (reason === 'credential') privacyCredentialGeneration += 1;
  privacyRevocationGeneration += 1;
  for (const listener of revocationListeners) listener();
}

export async function invalidatePrivacyQueries(
  queryClient: QueryClient,
  beforeRefetch?: () => Promise<void>,
): Promise<void> {
  // Retire imperative snapshots before the first await, including callbacks
  // captured before React can render the withdrawn access.
  // Begin the SQLite gate before listeners can start resolving their references.
  // A failed revalidation must still withdraw the currently displayed snapshots.
  let revalidation: Promise<void>;
  try {
    revalidation = (beforeRefetch ?? revalidatePrivacy)?.() ?? Promise.resolve();
  } catch (error) {
    revalidation = Promise.reject(error);
  }
  // Server-authorized reads and successful mutations must not wait for SQLite.
  // The repair owns the local gate and its retries, including after this returns.
  void revalidation.catch((error: unknown) => {
    reportHandledError(error, { tags: { source: 'privacy-revalidation' } });
  });
  invalidatePrivacySnapshots();
  const filters = {
    predicate: (query: { queryKey: readonly unknown[] }) => privacyQueryTreatment(query.queryKey) !== 'keep',
  };
  const withdrawFilters = {
    predicate: (query: Query) => {
      const treatment = privacyQueryTreatment(query.queryKey);
      return treatment === 'withdraw' || (treatment === 'refetch' && !query.isActive());
    },
  };
  // Keep the selected wall usable while catalogue withdrawal is in flight or
  // offline. Its reference and local hardware settings are independent of the
  // identifying projection; never replace the active board with a loading gap.
  const withdrawActiveBoard = () => {
    const query = queryClient.getQueryCache().find({ queryKey: ['activeBoard'], exact: true });
    const board = query?.state.data as UserBoard | null | undefined;
    if (query && board) query.setState({ data: sanitizeActiveBoard(board) });
  };
  withdrawActiveBoard();
  await queryClient.cancelQueries(filters);
  // Cancellation can restore a request's previous cache state. Sanitize that
  // state too before preserving it through the asynchronous catalogue purge.
  withdrawActiveBoard();
  for (const query of queryClient.getQueryCache().findAll(withdrawFilters)) {
    if (query.queryKey.length === 1 && query.queryKey[0] === 'activeBoard') continue;
    // resetQueries may restore initialData, which can itself hold withdrawn
    // content. Clear explicitly before any fresh authorization response.
    query.setState({ data: undefined, dataUpdatedAt: 0, error: null, status: 'pending' });
  }
  await queryClient.invalidateQueries(filters);
}
