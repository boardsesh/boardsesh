import { boardTypeLabel } from '@boardsesh/board-constants';
import type { getServerTranslation } from '@/app/lib/i18n/server';
import type { SessionOgSummary } from './dynamic-og-data';
import { buildOgContentVersion, buildOgFamilyImageUrl, isDailySessionId } from './og-family';
import { buildVersionedOgImagePath } from './og';

type SessionTranslate = Awaited<ReturnType<typeof getServerTranslation>>['t'];

export type SessionShareCopy = { ogTitle: string; ogDescription: string };

function formatBoards(boardTypes: readonly string[], locale: string): string {
  const labels = [...new Set(boardTypes)].map(boardTypeLabel);
  return labels.length > 0 ? new Intl.ListFormat(locale, { type: 'conjunction' }).format(labels) : 'Boardsesh';
}

/**
 * Who a recap names. A crew session reads as one person plus the rest; the count
 * covers everyone a stranger can see logging, including anyone they may not name.
 */
function recapName(summary: SessionOgSummary, t: SessionTranslate): { name: string; isCrew: boolean } {
  const participants = summary.recapParticipants;
  const named = participants.flatMap((participant) => (participant.name ? [participant.name] : []));
  if (participants.length <= 1) return { name: named[0] ?? t('metadata.recap.nameFallback'), isCrew: false };
  if (named.length === 0)
    return { name: t('metadata.recap.nameCrewUnnamed', { count: participants.length }), isCrew: true };
  return { name: t('metadata.recap.nameCrew', { name: named[0], count: participants.length - 1 }), isCrew: true };
}

/**
 * The words above a session recap card: its hardest grade and how it went,
 * never a claim about what is happening now.
 */
export function buildSessionRecapShareCopy(
  summary: SessionOgSummary,
  locale: string,
  t: SessionTranslate,
): SessionShareCopy {
  const { name, isCrew } = recapName(summary, t);
  const boards = formatBoards(summary.boardTypes, locale);
  const sends = summary.totalSends;
  const hardest = summary.hardestSend;

  if (sends === 0) {
    const grade = summary.hardestAttempt?.grade;
    let ogTitle: string;
    if (!grade) ogTitle = t('metadata.recap.ogTitleSession', { name });
    else if (isCrew) ogTitle = t('metadata.recap.ogTitleProjectingCrew', { name, grade });
    else ogTitle = t('metadata.recap.ogTitleProjecting', { name, grade });
    return {
      ogTitle,
      ogDescription: t('metadata.recap.ogDescriptionProjecting', { count: summary.tickCount, boards }),
    };
  }

  let ogTitle: string;
  if (!hardest) ogTitle = t('metadata.recap.ogTitleSendsNoGrade', { name, count: sends });
  else if (sends === 1 && hardest.flashed)
    ogTitle = t('metadata.recap.ogTitleOneFlash', { name, grade: hardest.grade, boards });
  else if (sends === 1) ogTitle = t('metadata.recap.ogTitleOneSend', { name, grade: hardest.grade, boards });
  else if (summary.totalFlashes === sends)
    ogTitle = t('metadata.recap.ogTitleAllFlashed', { name, count: sends, grade: hardest.grade });
  else ogTitle = t('metadata.recap.ogTitleSends', { name, count: sends, grade: hardest.grade });

  // Grades and counts only: the climb behind the hardest grade can be one the
  // community hid, which a share must never name (see `SessionOgHighlight`).
  if (summary.durationMinutes) {
    const duration = new Intl.NumberFormat(locale, { style: 'unit', unit: 'minute', unitDisplay: 'long' }).format(
      summary.durationMinutes,
    );
    return { ogTitle, ogDescription: t('metadata.recap.ogSendsInDuration', { count: sends, duration, boards }) };
  }
  return { ogTitle, ogDescription: t('metadata.recap.ogSendsOnBoards', { count: sends, boards }) };
}

/**
 * The words above an invite card. An ended session has no invite to make: the
 * card serves its recap, so the words do too and never say Join.
 */
export function buildSessionJoinShareCopy(
  summary: SessionOgSummary,
  locale: string,
  t: SessionTranslate,
): SessionShareCopy {
  if (!summary.isLive) return buildSessionRecapShareCopy(summary, locale, t);

  const name = summary.inviteName;
  const board = summary.liveBoard ? boardTypeLabel(summary.liveBoard.boardType) : null;
  const angle = summary.liveBoard?.angle ?? null;
  let ogTitle: string;
  if (board && angle !== null) {
    ogTitle = name
      ? t('metadata.join.ogTitleBoardAngle', { name, board, angle })
      : t('metadata.join.ogTitleCrewBoardAngle', { board, angle });
  } else if (board) {
    ogTitle = name ? t('metadata.join.ogTitleBoard', { name, board }) : t('metadata.join.ogTitleCrewBoard', { board });
  } else {
    ogTitle = name ? t('metadata.join.ogTitleWall', { name }) : t('metadata.join.ogTitleCrewWall');
  }

  const sends = summary.totalSends;
  let ogDescription: string;
  if (sends === 0) ogDescription = t('metadata.join.ogDescriptionNoSends');
  else if (summary.hardestSend)
    ogDescription = t('metadata.join.ogDescriptionSends', { count: sends, grade: summary.hardestSend.grade });
  else ogDescription = t('metadata.join.ogDescriptionSendsNoGrade', { count: sends });
  return { ogTitle, ogDescription };
}

/**
 * The card a session page advertises, or null when there is none to advertise.
 *
 * A `daily:` feed group keeps the web route's card: the backend refuses those
 * ids. Everything else points at the backend, and only when its gate will pass:
 * the recap needs a tick a stranger may see, and the invite needs the session
 * live or, once it has ended, that same recap. A 404 behind an og:image is a
 * broken preview, so a page with nothing to draw advertises no card at all.
 */
export function buildSessionOgImageUrl(
  sessionId: string,
  summary: SessionOgSummary,
  variant: 'recap' | 'join',
): string | null {
  if (!summary.found) return null;
  if (isDailySessionId(sessionId)) {
    return buildVersionedOgImagePath(
      '/api/og/session',
      { sessionId, variant: variant === 'join' ? 'join' : undefined },
      summary.version,
    );
  }
  // The newest tick's time misses a tick going private or a climber being
  // masked, so the token also covers what the recap draws.
  const recapVersion = buildOgContentVersion(
    summary.version,
    summary.tickCount,
    summary.totalSends,
    summary.totalFlashes,
    summary.hardestSend,
    summary.hardestAttempt,
    summary.recapParticipants,
  );
  if (variant === 'recap') {
    return summary.tickCount > 0 ? buildOgFamilyImageUrl('session', { sessionId }, recapVersion) : null;
  }
  if (!summary.isLive && summary.tickCount === 0) return null;
  return buildOgFamilyImageUrl(
    'session',
    { sessionId, variant: 'join' },
    buildOgContentVersion(recapVersion, summary.isLive, summary.inviteName, summary.liveBoard),
  );
}
