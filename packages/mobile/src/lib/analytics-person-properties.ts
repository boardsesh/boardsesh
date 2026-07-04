// Durable PostHog person properties for cohorting (issue #3399), split so the
// caller can forward them to setPersonProperties(set, setOnce): `set` overwrites
// on every call (mutable traits); `setOnce` writes only once, guarding the
// immutable account-created date that web and mobile share on one PostHog person.

export type CohortPersonPropertyInputs = {
  accountCreatedAt: string;
  // null when the user hasn't picked a board yet — omitted rather than a null cohort.
  homeBoard: string | null;
  isTester: boolean;
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
    // String enum, not a bare boolean: reads cleanly in PostHog breakdowns and
    // leaves room for more roles than tester/user.
    role: isTester ? 'tester' : 'user',
    favorite_count: favoriteCount,
  };
  if (homeBoard) {
    set.home_board = homeBoard;
  }
  return {
    set,
    setOnce: { account_created_at: accountCreatedAt },
  };
}
