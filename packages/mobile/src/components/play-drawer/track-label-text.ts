import type { TFunction } from 'i18next';
import type { TrackLabelModel } from '@boardsesh/play-view';
import { getCachedNumberFormat } from '../../lib/intl-formatter-cache';

/**
 * The list the player walks, as the two pieces the top bar lays out side by
 * side: the name, which the layout may cut, and the count, which it never does.
 */
export type TrackLabelParts = {
  /** The list's name, whole. Only the layout cuts it. */
  name: string;
  /** "4 of 23", or null when the count isn't known to be right. */
  count: string | null;
  /** The whole label for VoiceOver, never cut: "Playing from Projects, 4 of 23". */
  accessibilityLabel: string;
};

/**
 * The words for a track label model: "Projects" and "4 of 23", or the name
 * alone, or nothing. Numbers are grouped for the climber's language, so a long
 * search reads "4 of 1,234". No "From": the name is a list name in every
 * language, and German would need the dative ("Aus Suchergebnissen").
 */
export function formatTrackLabelParts(
  model: TrackLabelModel,
  t: TFunction<'session'>,
  locale: string,
): TrackLabelParts | null {
  if (model.kind === 'hidden') return null;
  const { name } = model;
  if (model.kind === 'named') {
    return { name, count: null, accessibilityLabel: t('playView.track.playingFromAria', { name }) };
  }
  const numbers = getCachedNumberFormat(locale);
  const position = numbers.format(model.position);
  const total = numbers.format(model.total);
  return {
    name,
    count: t('playView.track.position', { position, total }),
    accessibilityLabel: t('playView.track.playingFromPositionAria', { name, position, total }),
  };
}
