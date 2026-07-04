// Writes durable PostHog person properties for the signed-in user (issue #3399):
// account age, home board, tester role, and favourite depth. These are user
// *traits*, set once the authenticated profile resolves, so every App Success
// dashboard tile can segment by who the user is — not only what they did.
//
// Mounted once at the app root inside PartyProfileProvider (below AuthProvider +
// QueryProvider, where both data hooks are valid). Renders null. No-op while
// signed out, and while analytics is disabled (dev / no key) — the
// setPersonProperties wrapper drops the write when getClient() returns null.

import { useEffect } from 'react';
import { setPersonProperties } from '../../lib/analytics';
import { buildCohortPersonProperties } from '../../lib/analytics-person-properties';
import { useProfile } from '../../lib/graphql/hooks';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useAuth } from '../../providers/auth-provider';

export function AnalyticsPersonProperties(): null {
  const { isAuthenticated } = useAuth();
  // Shared ['profile'] query key — dedupes with PartyProfileProvider and the
  // profile screens that also read it, so this adds no extra fetch.
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  // Cheap AsyncStorage-backed read (no network). Deliberately the active board
  // rather than useHomeBoard(), which would fan out a logbook-ticks query at app
  // root just for analytics.
  const { data: activeBoard } = useActiveBoard();

  const profileId = profile?.id ?? null;
  const accountCreatedAt = profile?.createdAt ?? null;
  const isTester = profile?.isTester ?? false;
  const favoriteCount = profile?.favoriteCount ?? 0;
  const homeBoard = activeBoard?.boardType ?? null;

  useEffect(() => {
    // Need an identified user with a created-at before writing traits; skip while
    // signed out or before the profile resolves.
    if (!isAuthenticated || !profileId || !accountCreatedAt) return;
    const { set, setOnce } = buildCohortPersonProperties({
      accountCreatedAt,
      homeBoard,
      isTester,
      favoriteCount,
    });
    setPersonProperties(set, setOnce);
  }, [isAuthenticated, profileId, accountCreatedAt, homeBoard, isTester, favoriteCount]);

  return null;
}
