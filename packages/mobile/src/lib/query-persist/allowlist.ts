// The allowlist. This is a HARD GATE on the dehydrate path, not a filter that
// someone can forget to update: every rule pins both the exact first key element
// and the exact key length, so `['profile', somethingNew]` misses, and a future
// `['profileSettings']` key cannot slip through on a prefix match.
//
// What is deliberately NOT here (issue #4353 / docs/offline-reads.md):
//  - anything SQLite already owns (`searchClimbs`, `infiniteSearchClimbs`,
//    `searchClimbsCount`, `climb`, `boardseshGrade`, `localTicks`, `logbook`),
//  - `['activeBoard']` — already AsyncStorage-backed in `use-active-board.ts`,
//    so persisting it here would double-store it,
//  - everything with "now" semantics: feeds, sessions, `searchUsers`,
//    `comments`, `bulkVoteSummaries`.

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export type PersistRule = {
  /** Exact first key element. */
  readonly head: string;
  /** Exact key length — arity is what makes this a gate rather than a prefix filter. */
  readonly arity: number;
  /** Measured from `state.dataUpdatedAt`; older entries are dropped on restore. */
  readonly maxAgeMs: number;
  /** LOWEST evicts first when the 512 KB cap is hit. */
  readonly priority: number;
  /** Extra per-rule check; a `false` return rejects the key. */
  readonly guard?: (queryKey: readonly unknown[], ownerUserId: string) => boolean;
};

export const PERSISTED_QUERY_RULES: readonly PersistRule[] = [
  // Highest priority: the entry that decides whether /boards/manage can render
  // at all (`currentUserId = profile?.id ?? storedUserId`).
  { head: 'profile', arity: 1, maxAgeMs: FOURTEEN_DAYS_MS, priority: 60 },
  // Every `['myBoards', input]` variant, not just the plain roster: `useMyBoards`
  // is called with `undefined` on manage/index/more and with an input elsewhere.
  // Arity is the gate; the 64 KB per-entry cap and priority-50 eviction bound it.
  { head: 'myBoards', arity: 2, maxAgeMs: FOURTEEN_DAYS_MS, priority: 50 },
  { head: 'myGyms', arity: 1, maxAgeMs: FOURTEEN_DAYS_MS, priority: 40 },
  { head: 'grades', arity: 2, maxAgeMs: FOURTEEN_DAYS_MS, priority: 30 },
  { head: 'angles', arity: 3, maxAgeMs: FOURTEEN_DAYS_MS, priority: 20 },
  // Only the signed-in user's own public profile, and only for a day: it carries
  // follower counts and recent activity, which go stale fast.
  {
    head: 'publicProfile',
    arity: 2,
    maxAgeMs: ONE_DAY_MS,
    priority: 10,
    guard: (queryKey, ownerUserId) => queryKey[1] === ownerUserId,
  },
];

/** The rule this key persists under, or undefined when it is not allowlisted. */
export function matchPersistRule(queryKey: readonly unknown[], ownerUserId: string): PersistRule | undefined {
  const head = queryKey[0];
  if (typeof head !== 'string') return undefined;
  return PERSISTED_QUERY_RULES.find(
    (rule) => rule.head === head && queryKey.length === rule.arity && rule.guard?.(queryKey, ownerUserId) !== false,
  );
}
