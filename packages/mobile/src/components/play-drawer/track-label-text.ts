import type { TFunction } from 'i18next';
import type { TrackLabelModel } from '@boardsesh/play-view';
import type { BrowseCaption } from './wall-state';
import { getCachedNumberFormat } from '../../lib/intl-formatter-cache';

/**
 * Longest list or climb name the header's stats line prints whole. The label
 * leads a one-line stats row, so a long name would push the count off the end,
 * and the count ("4 of 23") is the part a climber reads the label for. A
 * longer name is cut short here, so the line's own truncation takes the stats
 * at its tail first. The browse caption's wall climb name follows the same cap.
 */
export const MAX_TRACK_NAME_LENGTH = 24;

/** `name` cut to {@link MAX_TRACK_NAME_LENGTH} characters, never mid-character. */
function shortHeaderName(name: string): string {
  const characters = Array.from(name);
  if (characters.length <= MAX_TRACK_NAME_LENGTH) return name;
  return `${characters
    .slice(0, MAX_TRACK_NAME_LENGTH - 1)
    .join('')
    .trimEnd()}…`;
}

/**
 * The header's words for a track label model: "From Projects · 4 of 23", or
 * "From Projects" with no count, or nothing. Numbers are grouped for the
 * climber's language, so a long search reads "4 of 1,234".
 */
export function formatTrackLabel(model: TrackLabelModel, t: TFunction<'session'>, locale: string): string | null {
  if (model.kind === 'hidden') return null;
  const name = shortHeaderName(model.name);
  if (model.kind === 'named') return t('playView.track.from', { name });
  const numbers = getCachedNumberFormat(locale);
  return t('playView.track.fromPosition', {
    name,
    position: numbers.format(model.position),
    total: numbers.format(model.total),
  });
}

/**
 * The header's words for the browse caption: "Preview, not lit" solo, "Only you
 * see this" in a crew, with "· the wall is on Crimp Ladder" when the room has a
 * climb lit. It leads the stats line, so the climb name is cut like a list name.
 */
export function formatBrowseCaption(caption: BrowseCaption, t: TFunction<'session'>): string | null {
  if (caption === null) return null;
  if (caption.kind === 'preview') return t('playView.wallState.previewNotLit');
  const wallClimbName = caption.wallClimbName?.trim();
  if (!wallClimbName) return t('playView.wallState.onlyYouSeeThis');
  return t('playView.wallState.onlyYouSeeThisWallOn', { name: shortHeaderName(wallClimbName) });
}
