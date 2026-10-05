import { useEffect, useRef } from 'react';
import { useAuth } from '../providers/auth-provider';
// From the barrel, like the join screen itself, so the two share one cached
// query (same key) and one mock in tests.
import { useSessionPreview } from '../lib/graphql/hooks';
import { joinScreenDeadEnd, trackSessionJoinOutcome } from '../lib/session-join-analytics';

/**
 * Fire `Session Join Outcome` once for each dead end the join screen shows:
 * session not found, session ended, sign-in needed, or the invite failed to
 * load. A failed join after tapping Join is tracked where it is caught.
 *
 * Reads the same preview query as the screen (same key, so one request), and
 * fires on a change of outcome, not on every render: a retry that fails again
 * is the same dead end, a retry that then finds the session ended is a new one.
 */
export function useSessionJoinOutcomeTracking(sessionId: string | undefined): void {
  const { isAuthenticated } = useAuth();
  const preview = useSessionPreview(sessionId, { inviteFallback: true });
  const deadEnd = joinScreenDeadEnd({
    isAuthenticated,
    isLoading: preview.isLoading,
    isError: preview.isError,
    session: preview.data,
  });

  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || !deadEnd) return;
    const reportKey = `${sessionId}:${deadEnd}`;
    if (reported.current === reportKey) return;
    reported.current = reportKey;
    trackSessionJoinOutcome(sessionId, deadEnd, 'preview');
  }, [sessionId, deadEnd]);
}
