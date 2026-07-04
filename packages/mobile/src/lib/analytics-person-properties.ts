// Durable PostHog person properties for cohorting (issue #3399). These are user
// *traits* — not behaviour — so the App Success dashboard can split retention and
// lifecycle tiles by account maturity, home board, tester status, and favourite
// depth. That segmentation is impossible with behaviour-only cohorts, where the
// only person property mobile writes today is `email`.
//
// Pure and platform-free so it's unit-testable without React Native. The caller
// (AnalyticsPersonProperties) sources the inputs from the authenticated profile
// and the active board, then forwards the result to setPersonProperties(set,
// setOnce): `set` overwrites on every call (mutable traits), `setOnce` writes only
// once (immutable account age — guards the value web and mobile share on one
// PostHog person).

export type CohortPersonPropertyInputs = {
  // Account creation timestamp (ISO 8601) from the backend profile. Immutable.
  accountCreatedAt: string;
  // The board type the user actively climbs on ('kilter' / 'tension' / …), or null
  // when they haven't picked one yet — omitted rather than written as null.
  homeBoard: string | null;
  // Whether the account has the tester/admin role (beta channel).
  isTester: boolean;
  // Total climbs the user has favourited, across all boards.
  favoriteCount: number;
};

export type CohortPersonProperties = {
  set: Record<string, string | number | boolean>;
  setOnce: Record<string, string>;
};

export function buildCohortPersonProperties({
  accountCreatedAt,
  homeBoard,
  isTester,
  favoriteCount,
}: CohortPersonPropertyInputs): CohortPersonProperties {
  const set: Record<string, string | number | boolean> = {
    // String enum over a bare boolean, mirroring web's `signup_auth_method` — reads
    // cleanly in PostHog breakdowns and leaves room for more roles than tester/user.
    role: isTester ? 'tester' : 'user',
    favorite_count: favoriteCount,
  };
  // Omit home_board entirely until the user picks a board — a null would just be a
  // meaningless cohort bucket.
  if (homeBoard) {
    set.home_board = homeBoard;
  }
  return {
    set,
    setOnce: { account_created_at: accountCreatedAt },
  };
}
