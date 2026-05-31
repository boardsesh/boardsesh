// Injected platform seams for the board-data hooks. Each hook takes only the
// slice it needs — this keeps platform wrappers from pulling in unrelated I/O
// (e.g. the tick path never touches the climb-error toast). Mirrors the
// dependency-injection approach of `@boardsesh/queue-react`.

/** One-shot GraphQL request. Web injects an HTTP/WS client call; mobile the same. */
export type GraphQLRequestFn = <TData>(document: string, variables?: Record<string, unknown>) => Promise<TData>;

/**
 * Auth gate for mutations. Throws (synchronously) with the platform's own
 * message(s) when the caller isn't allowed to mutate; returns void when ready.
 * A function rather than a boolean so platforms can preserve distinct messages
 * (web's tick path throws 'Not authenticated' vs 'Auth token not available').
 */
export type AssertAuthed = () => void;

/** Logbook fetch (GET_TICKS over HTTP). */
export type LogbookDeps = {
  /** Reactive gate for `enabled` (web: authenticated && hasToken). */
  isAuthenticated: boolean;
  requestHttp: GraphQLRequestFn;
};

/** Tick save (SAVE_TICK over HTTP) with optimistic accumulated-cache updates. */
export type SaveTickDeps = {
  assertAuthed: AssertAuthed;
  requestHttp: GraphQLRequestFn;
  /** Optional draft cleanup on success (web IndexedDB; mobile omits). */
  clearTickDraft?: (climbUuid: string, angle: number) => void;
};

/** Climb create (SAVE_CLIMB over WS). */
export type SaveClimbDeps = {
  assertAuthed: AssertAuthed;
  requestWs: GraphQLRequestFn;
  /** Generic-failure feedback (web snackbar; mobile toast). Already localized. */
  onSaveClimbError: () => void;
  /** Optional post-success cache invalidation (platform owns its query keys). */
  onSaved?: () => void;
};

/** Climb update (UPDATE_CLIMB over WS). */
export type UpdateClimbDeps = {
  assertAuthed: AssertAuthed;
  requestWs: GraphQLRequestFn;
  /** Optional failure feedback (web omits today; mobile toasts). */
  onError?: () => void;
  /** Optional post-success cache invalidation. */
  onSaved?: () => void;
};
