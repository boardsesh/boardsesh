import type { TFunction } from 'i18next';
import type { TrackLabelModel } from '@boardsesh/play-view';
import type { BrowseCaption } from './wall-state';
import { getCachedNumberFormat } from '../../lib/intl-formatter-cache';

/**
 * "then Projects" after an Up next count, in three pieces so the layout cuts
 * only the list's name: the words before it and after it always show whole.
 */
export type TrackThenParts = {
  before: string;
  name: string;
  after: string;
};

/**
 * The list the player walks, as the pieces the top bar lays out side by side:
 * the name, which the layout may cut, the count, which it never does, and on a
 * climb Up next whose list carries on, what comes after it.
 */
export type TrackLabelParts = {
  /** The list's name, whole. Only the layout cuts it. */
  name: string;
  /** "4 of 23", or null when the count isn't known to be right. */
  count: string | null;
  /**
   * "then Projects" (the then-signposts): the list a walk playing Up next picks
   * up once Up next is played. Absent everywhere else, a workout stage included.
   */
  thenTail?: TrackThenParts | null;
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
  if (model.kind === 'upNext') return formatUpNextLabelParts(model.count, model.thenListName, t, locale);
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

/**
 * "Up next · 1 of 3" while a queued climb plays in the middle of a list
 * (#6777). The name is the queue's own section name, so the top bar reads the
 * way the queue sheet does. `thenListName` adds "· then Projects" while the
 * list carries on after Up next, and the spoken label says it too.
 */
function formatUpNextLabelParts(
  count: { position: number; total: number } | null,
  thenListName: string | null,
  t: TFunction<'session'>,
  locale: string,
): TrackLabelParts {
  const name = t('playView.track.upNext');
  const thenTail = thenListName ? formatThenParts(thenListName, t) : null;
  if (!count) {
    return {
      name,
      count: null,
      thenTail,
      accessibilityLabel: thenListName ? t('playView.track.upNextThenAria', { name: thenListName }) : name,
    };
  }
  const numbers = getCachedNumberFormat(locale);
  const position = numbers.format(count.position);
  const total = numbers.format(count.total);
  return {
    name,
    count: t('playView.track.position', { position, total }),
    thenTail,
    accessibilityLabel: thenListName
      ? t('playView.track.upNextPositionThenAria', { position, total, name: thenListName })
      : t('playView.track.upNextPositionAria', { position, total }),
  };
}

/** Stands in for the list's name while the "then" sentence is cut around it. */
const THEN_NAME_MARK = '\u2063';

/**
 * "then Projects" split around the list's name, wherever the language puts it,
 * so the top bar can cut the name and keep the rest. A translation that lost
 * the name keeps the whole sentence before it and prints the name after.
 */
export function formatThenParts(listName: string, t: TFunction<'session'>): TrackThenParts {
  const sentence = t('playView.track.then', { name: THEN_NAME_MARK });
  const markAt = sentence.indexOf(THEN_NAME_MARK);
  if (markAt < 0) return { before: `${sentence} `, name: listName, after: '' };
  return {
    before: sentence.slice(0, markAt),
    name: listName,
    after: sentence.slice(markAt + THEN_NAME_MARK.length),
  };
}

/** The "then" part as printed, joined back up: "then Projects". */
export function printedThen(tail: TrackThenParts): string {
  return `${tail.before}${tail.name}${tail.after}`;
}

/**
 * Longest wall climb name the browse caption prints whole. The caption leads
 * the header's one-line stats line, so a long name would push the sends and
 * stars off the end. A longer name is cut short here, so the line's own
 * truncation takes the stats at its tail first.
 */
export const MAX_CAPTION_NAME_LENGTH = 24;

/** `name` cut to {@link MAX_CAPTION_NAME_LENGTH} characters, never mid-character. */
export function shortCaptionName(name: string): string {
  const characters = Array.from(name);
  if (characters.length <= MAX_CAPTION_NAME_LENGTH) return name;
  return `${characters
    .slice(0, MAX_CAPTION_NAME_LENGTH - 1)
    .join('')
    .trimEnd()}…`;
}

/**
 * The top bar's words for the browse caption: "Preview · not on the wall" solo,
 * "Only you see this" in a crew, with "· the wall is on Crimp Ladder" when the
 * room has a climb lit. It shares the narrow top bar with the list, so the climb
 * name is cut short. A screen reader hears it through {@link spokenCaption}.
 *
 * `sharesLine` is true when the top bar's first line also names a list or a
 * workout stage. The wall climb's name is then left out: the top bar sits
 * between ⌄ and the timer + ⋯ cluster, and the long crew form alone runs to 59
 * characters, far past what fits there. The pill's face still says who lit the
 * wall.
 */
export function formatBrowseCaption(
  caption: BrowseCaption,
  t: TFunction<'session'>,
  { sharesLine = false }: { sharesLine?: boolean } = {},
): string | null {
  if (caption === null) return null;
  if (caption.kind === 'preview') return t('playView.wallState.previewNotOnWall');
  const wallClimbName = caption.wallClimbName?.trim();
  if (!wallClimbName || sharesLine) return t('playView.wallState.onlyYouSeeThis');
  return t('playView.wallState.onlyYouSeeThisWallOn', { name: shortCaptionName(wallClimbName) });
}

/**
 * The caption as a screen reader says it: the "·" between its parts is for the
 * eye, so it is read as a comma rather than "middle dot". Every locale writes
 * the separator the same way, a space on each side.
 */
export function spokenCaption(caption: string): string {
  return caption.replace(/\s+·\s+/g, ', ');
}
