// Copy for live-session cards and rows, built from the pure descriptors in
// `live-session-model.ts`. Takes `t` bound to the `feed` namespace so the i18n
// orphan checker can resolve every key below.

import type { TFunction } from 'i18next';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import { isQuietSession, type ElapsedParts, type LiveCardModel, type LiveNamesDescriptor } from './live-session-model';

export type LiveNamesCopy = {
  /** The names, ellipsized by the view. */
  names: string;
  /** "+3" in its own non-shrinking text, or null. */
  extra: string | null;
  /** The same people read aloud ("Priya N. and 3 others"). */
  spoken: string;
};

export function liveNamesCopy(descriptor: LiveNamesDescriptor, t: TFunction<'feed'>): LiveNamesCopy {
  switch (descriptor.kind) {
    case 'justYou': {
      const names = t('mobile.liveSessions.names.justYou');
      return { names, extra: null, spoken: names };
    }
    case 'youAnd': {
      const names = t('mobile.liveSessions.names.youAnd', { name: descriptor.name });
      return { names, extra: null, spoken: names };
    }
    case 'you':
      return {
        names: t('mobile.liveSessions.names.you'),
        extra: `+${descriptor.others}`,
        spoken: t('mobile.liveSessions.a11y.youOthers', { count: descriptor.others }),
      };
    case 'two': {
      const names = t('mobile.liveSessions.names.two', { first: descriptor.first, second: descriptor.second });
      return { names, extra: null, spoken: names };
    }
    case 'one': {
      const name = descriptor.name ?? t('mobile.liveSessions.names.someone');
      if (descriptor.others <= 0) return { names: name, extra: null, spoken: name };
      return {
        names: name,
        extra: `+${descriptor.others}`,
        spoken: t('mobile.liveSessions.a11y.namesOthers', { name, count: descriptor.others }),
      };
    }
  }
}

/** "Just started", "12m", "1h", "1h 5m". A bare "0m" reads like a broken timer. */
export function elapsedShort({ hours, minutes }: ElapsedParts, t: TFunction<'feed'>): string {
  if (hours === 0 && minutes === 0) return t('mobile.liveSessions.elapsed.justStarted');
  if (hours === 0) return t('mobile.liveSessions.elapsed.minutes', { minutes });
  if (minutes === 0) return t('mobile.liveSessions.elapsed.hours', { hours });
  return t('mobile.liveSessions.elapsed.hoursMinutes', { hours, minutes });
}

/** "12 minutes", "1 hour 5 minutes": VoiceOver reads "12m" as "12 meters". */
export function elapsedSpoken({ hours, minutes }: ElapsedParts, t: TFunction<'feed'>): string {
  const parts: string[] = [];
  if (hours > 0) parts.push(t('mobile.liveSessions.a11y.hours', { count: hours }));
  if (minutes > 0 || hours === 0) parts.push(t('mobile.liveSessions.a11y.minutes', { count: minutes }));
  return parts.join(' ');
}

/** "started 12 minutes ago", or "just started" inside the first minute. */
export function startedSpoken(elapsed: ElapsedParts, t: TFunction<'feed'>): string {
  if (elapsed.hours === 0 && elapsed.minutes === 0) return t('mobile.liveSessions.a11y.justStarted');
  return t('mobile.liveSessions.a11y.started', { elapsed: elapsedSpoken(elapsed, t) });
}

/** The board's own name, else the board type's display name ("Kilter"). */
export function liveBoardName(card: Pick<LiveCardModel, 'boardName' | 'boardType'>): string | null {
  if (card.boardName) return card.boardName;
  return card.boardType ? formatBoardDisplayName(card.boardType) : null;
}

/** "Kilter Original · 40°". */
export function liveBoardLine(card: Pick<LiveCardModel, 'boardName' | 'boardType' | 'angle'>, t: TFunction<'feed'>) {
  const board = liveBoardName(card);
  if (!board) return null;
  return card.angle != null ? t('mobile.liveSessions.boardLine', { board, angle: card.angle }) : board;
}

export type LiveCardSpokenInput = {
  names: LiveNamesCopy;
  card: LiveCardModel;
  elapsed: ElapsedParts;
  /** Grades already run through the climber's grade format. */
  hardestGrade: string | null;
  climbGrade: string | null;
};

/**
 * One label for the whole card, so VoiceOver reads a session as one element:
 * "Priya N. and 2 others, live on Kilter Original at 40 degrees, Crux
 * Collective, started 42 minutes ago, 7 sends, hardest V6".
 */
export function liveCardSpokenLabel(
  { names, card, elapsed, hardestGrade, climbGrade }: LiveCardSpokenInput,
  t: TFunction<'feed'>,
): string {
  const parts: string[] = [names.spoken];
  const board = liveBoardName(card);
  // A session nobody is connected to is read as quiet, never as live.
  const quiet = isQuietSession(card);
  if (board) {
    const spokenBoard =
      card.angle != null ? t('mobile.liveSessions.a11y.boardAngle', { board, angle: card.angle }) : board;
    parts.push(
      quiet
        ? t('mobile.liveSessions.a11y.quietOn', { board: spokenBoard })
        : t('mobile.liveSessions.a11y.liveOn', { board: spokenBoard }),
    );
  } else {
    parts.push(quiet ? t('mobile.liveSessions.a11y.quietNow') : t('mobile.liveSessions.a11y.liveNow'));
  }
  if (card.gymName) parts.push(card.gymName);
  if (card.currentClimbName) {
    parts.push(
      climbGrade
        ? t('mobile.liveSessions.onClimbGrade', { climb: card.currentClimbName, grade: climbGrade })
        : t('mobile.liveSessions.onClimb', { climb: card.currentClimbName }),
    );
  }
  parts.push(startedSpoken(elapsed, t));
  if (card.sendCount > 0) parts.push(t('mobile.liveSessions.sends', { count: card.sendCount }));
  if (hardestGrade) parts.push(t('mobile.liveSessions.a11y.hardest', { grade: hardestGrade }));
  return parts.join(', ');
}
