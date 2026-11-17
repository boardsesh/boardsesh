import type { TFunction } from 'i18next';
import type { TrackLabelModel } from '@boardsesh/play-view';
import { getCachedNumberFormat } from '../../lib/intl-formatter-cache';

/**
 * What the board, the swipe's adjustable screen-reader element, says as its
 * value: the climb on screen by name and grade, and where it sits in the list
 * the player walks: "Yoshi's Island, V5, 5 of 40". VoiceOver and TalkBack read
 * it after every adjust, and the player announces it when a step lands.
 *
 * `extra` is what the board said before this existed, read after the climb:
 * Up next's stretch ("Up next, 2 of 4, then Projects", which carries its own
 * position) or the preview note. Without a climb name the board says only that.
 *
 * The grade is whole, never cut (a V-grade always keeps its number).
 */
export function formatBoardClimbValue({
  climbName,
  grade,
  trackLabel,
  extra,
  t,
  locale,
}: {
  climbName: string | null | undefined;
  /** The grade the header shows, or its Project word; empty when there is none. */
  grade: string | null | undefined;
  /** The list the top bar names. Hidden where it names something else (a workout stage). */
  trackLabel: TrackLabelModel;
  extra?: string | null;
  t: TFunction<'session'>;
  locale: string;
}): string | undefined {
  const name = climbName?.trim();
  if (!name) return extra || undefined;
  const shownGrade = grade?.trim() || null;
  let climb: string;
  if (trackLabel.kind === 'counted') {
    const numbers = getCachedNumberFormat(locale);
    const position = numbers.format(trackLabel.position);
    const total = numbers.format(trackLabel.total);
    climb = shownGrade
      ? t('playView.track.climbPositionAria', { name, grade: shownGrade, position, total })
      : `${name}, ${t('playView.track.position', { position, total })}`;
  } else {
    climb = shownGrade ? t('playView.track.climbAria', { name, grade: shownGrade }) : name;
  }
  return extra ? `${climb}, ${extra}` : climb;
}
