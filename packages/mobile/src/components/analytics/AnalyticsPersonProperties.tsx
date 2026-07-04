// Writes durable PostHog person properties for the signed-in user (issue #3399)
// so App Success dashboard tiles can segment by who the user is, not just what
// they did. Mounted once at the app root; renders null.

import { useEffect } from 'react';
import { setPersonProperties } from '../../lib/analytics';
import { buildCohortPersonProperties } from '../../lib/analytics-person-properties';
import { useProfile } from '../../lib/graphql/hooks';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useAuth } from '../../providers/auth-provider';

export function AnalyticsPersonProperties(): null {
  const { isAuthenticated } = useAuth();
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  // The active board (a cheap AsyncStorage read), not useHomeBoard() — the latter
  // fans out a logbook-ticks query we don't want to run at app root for analytics.
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
