import type { TFunction } from 'i18next';
import { boardTypeLabel } from '@boardsesh/board-constants';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import { normalizedQuality } from '@/app/lib/climb-quality';

/**
 * Search-result copy for the climb and setter front doors.
 *
 * Each description is a run of whole sentences, every one its own catalogue
 * key, and a sentence is left out when the number behind it is missing or zero.
 * Whole sentences rather than fragments so a translator never has to make a
 * clause agree with a neighbour it cannot see; separate keys rather than one
 * string per combination, because three optional facts would be eight strings
 * in every locale.
 */

/** Chinese runs sentences together; the other catalogue locales separate them with a space. */
export function joinDescriptionSentences(sentences: readonly (string | null)[], locale: string): string {
  const separator = locale.startsWith('zh') ? '' : ' ';
  return sentences.filter((sentence): sentence is string => Boolean(sentence)).join(separator);
}

/**
 * The angle's quality on the five-star scale, or null when there is no honest
 * one. The rule is `normalizedQuality`'s, the same one the climb page's star
 * uses, so a snippet never rates a climb the page leaves unrated.
 */
export function climbQualityRating(
  stats: Pick<ClimbStatsForAngle, 'quality_normalized' | 'quality_average' | 'rating_count'> | undefined,
): number | null {
  return normalizedQuality(stats)?.average ?? null;
}

type ClimbSearchDescriptionInput = {
  t: TFunction;
  locale: string;
  /** Already through `resolveClimbDisplayName`, the same name the title uses. */
  climbName: string;
  /** Already through `climbGradeForSearch`. */
  grade: string;
  /** Already through `climbBoardForSearch`. */
  layoutName: string;
  angle: number;
  setter: string | null | undefined;
  /** Sends at the requested angle. */
  ascents: number | null | undefined;
  /** The requested angle's stats row; its quality is stated only when `climbQualityRating` vouches for it. */
  angleStats: ClimbStatsForAngle | undefined;
};

/**
 * The climb page's meta description:
 * "Foo is V5 (6c) on Kilter Board Original at 40°, set by Bar. 12 sends, rated 4.2 of 5. Light it on your board with Boardsesh."
 *
 * The setter clause goes when there is no setter, the sends when there are none,
 * and the rating when `climbQualityRating` cannot vouch for it.
 */
export function buildClimbSearchDescription({
  t,
  locale,
  climbName,
  grade,
  layoutName,
  angle,
  setter,
  ascents,
  angleStats,
}: ClimbSearchDescriptionInput): string {
  const setterName = setter?.trim();
  const sendCount = Math.max(0, Math.trunc(Number(ascents) || 0));
  const rating = climbQualityRating(angleStats);
  const sends = new Intl.NumberFormat(locale).format(sendCount);
  const quality = rating === null ? null : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(rating);

  const gradeLabel = grade.trim();

  // An angle with no stats row has no grade at all; "is  on" read as a typo.
  let lead: string;
  if (gradeLabel && setterName) {
    lead = t('metadata.view.descriptionLead', { climbName, grade: gradeLabel, layoutName, angle, setter: setterName });
  } else if (gradeLabel) {
    lead = t('metadata.view.descriptionLeadNoSetter', { climbName, grade: gradeLabel, layoutName, angle });
  } else if (setterName) {
    lead = t('metadata.view.descriptionLeadUngraded', { climbName, layoutName, angle, setter: setterName });
  } else {
    lead = t('metadata.view.descriptionLeadUngradedNoSetter', { climbName, layoutName, angle });
  }

  let stats: string | null = null;
  if (sendCount > 0 && quality !== null) {
    stats = t('metadata.view.descriptionSendsRated', { count: sendCount, ascents: sends, quality });
  } else if (sendCount > 0) {
    stats = t('metadata.view.descriptionSends', { count: sendCount, ascents: sends });
  } else if (quality !== null) {
    stats = t('metadata.view.descriptionRated', { quality });
  }

  return joinDescriptionSentences([lead, stats, t('metadata.view.descriptionCta')], locale);
}

type SetterSearchCopyInput = {
  t: TFunction;
  locale: string;
  name: string;
  /** Visible climbs, or null when the setter's page could not be read. */
  climbCount: number | null;
  /** Board types the visible climbs are on, in the order the title names them. */
  boardTypes: readonly string[];
  /** Sends across the setter's climbs, from the same summary the share card uses. */
  totalAscents: number;
  /** The `?page` being served. Pages past the first are indexable too, so each gets its own title. */
  page: number;
};

/**
 * A board type as the title names it. Brands are never translated, but a spray
 * wall is a kind of wall rather than a brand, and the glossaries name it.
 */
function setterBoardLabel(boardType: string, t: TFunction): string {
  return boardType === 'spray' ? t('metadata.setter.boardSprayWall') : boardTypeLabel(boardType);
}

/**
 * The setter page's search title and meta description:
 * "41 Kilter climbs set by Bar" and
 * "Bar has set 41 climbs on Kilter. 12,345 sends so far. Pick one and light it on your board with Boardsesh."
 *
 * Falls back to the plain "Climbs set by Bar" pair when the page read failed and
 * there is no count or board to name.
 */
export function buildSetterSearchCopy({
  t,
  locale,
  name,
  climbCount,
  boardTypes,
  totalAscents,
  page,
}: SetterSearchCopyInput): { title: string; description: string } {
  if (!climbCount || boardTypes.length === 0) {
    return {
      title: page > 1 ? t('metadata.setter.titlePage', { name, page }) : t('metadata.setter.title', { name }),
      description: t('metadata.setter.description', { name }),
    };
  }

  const numberFormat = new Intl.NumberFormat(locale);
  const boards = new Intl.ListFormat(locale, { type: 'conjunction' }).format(
    boardTypes.map((boardType) => setterBoardLabel(boardType, t)),
  );
  const climbs = numberFormat.format(climbCount);

  return {
    title:
      page > 1
        ? t('metadata.setter.titleWithClimbsPage', { name, boards, count: climbCount, climbs, page })
        : t('metadata.setter.titleWithClimbs', { name, boards, count: climbCount, climbs }),
    description: joinDescriptionSentences(
      [
        t('metadata.setter.descriptionSetCount', { name, boards, count: climbCount, climbs }),
        totalAscents > 0
          ? t('metadata.setter.descriptionSends', { count: totalAscents, sends: numberFormat.format(totalAscents) })
          : null,
        // "Pick one" needs more than one to pick from.
        climbCount === 1 ? t('metadata.setter.descriptionCtaSingle') : t('metadata.setter.descriptionCta'),
      ],
      locale,
    ),
  };
}
