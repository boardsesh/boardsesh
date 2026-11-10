import type { SessionOgSummary } from '@/app/lib/seo/dynamic-og-data';

/** A found, ended, one-climber session with nothing logged; tests override what they exercise. */
export function makeSessionOgSummary(overrides: Partial<SessionOgSummary> = {}): SessionOgSummary {
  return {
    sessionType: 'party',
    sessionName: 'Board Session',
    leaderName: null,
    participantNames: [],
    participantCount: 0,
    totalSends: 0,
    gradeRows: [],
    boardLabel: null,
    boardAngle: null,
    boardPreviewPath: null,
    version: 'abc123',
    found: true,
    isLive: false,
    inviteName: null,
    liveBoard: null,
    tickCount: 0,
    totalFlashes: 0,
    durationMinutes: null,
    recapParticipants: [],
    boardTypes: [],
    hardestSend: null,
    hardestAttempt: null,
    ...overrides,
  };
}

export const NOT_FOUND_SESSION_OG_SUMMARY: SessionOgSummary = makeSessionOgSummary({
  sessionType: null,
  sessionName: 'Climbing Session',
  version: '0',
  found: false,
});
