import type { TFunction } from 'i18next';
import { boardTypeLabel } from '@boardsesh/board-constants';

/**
 * A board type as the setter page names it, in the line and on the chips.
 *
 * Brands are never translated. A spray wall is a kind of wall rather than a
 * brand, so it reads the glossary term the page's search title uses
 * (`setterBoardLabel` in `lib/seo/search-description.ts`), so the line, the
 * chips and the title all name it the same way.
 */
export function setterBoardLabel(boardType: string, t: TFunction): string {
  return boardType === 'spray' ? t('metadata.setter.boardSprayWall') : boardTypeLabel(boardType);
}

type SetterStatsLineInput = {
  t: TFunction;
  locale: string;
  /** Publicly visible climbs, across every board: the page 404s before this when it is 0. */
  climbCount: number;
  /** Board types those climbs are on, in the order the page names them. */
  boardTypes: readonly string[];
  /**
   * Sends across the setter's climbs, from the summary the share card and the
   * search description read. 0 when nobody has sent one yet, or when that read
   * failed: either way the line names no send count rather than "sent 0 times".
   */
  totalAscents: number;
};

/**
 * The one line under the setter's name: "41 climbs on Kilter and Tension, sent
 * 9,860 times".
 *
 * Two catalogue sentences joined by a third key rather than one string per
 * combination: each half pluralises on its own count, and i18next pluralises a
 * string on one count only. The joiner is a key too, because Chinese joins the
 * halves with a full-width comma.
 */
export function buildSetterStatsLine({
  t,
  locale,
  climbCount,
  boardTypes,
  totalAscents,
}: SetterStatsLineInput): string {
  const numberFormat = new Intl.NumberFormat(locale);
  const boards = new Intl.ListFormat(locale, { type: 'conjunction' }).format(
    boardTypes.map((boardType) => setterBoardLabel(boardType, t)),
  );
  const climbs = t('setter.stats.climbs', { count: climbCount, climbs: numberFormat.format(climbCount), boards });

  if (!(totalAscents > 0)) return climbs;

  const sends = t('setter.stats.sends', { count: totalAscents, sends: numberFormat.format(totalAscents) });
  return t('setter.stats.joined', { climbs, sends });
}
