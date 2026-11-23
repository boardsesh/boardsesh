import { climbGradeForSearch } from '@/app/lib/seo/climb-display';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import { formatFirstAscentDate, sendCount } from './climb-facts-format';

/** The slice of i18next's `t` this module calls: a key and its values in, a sentence out. */
export type TranslateSentence = (key: string, values?: Record<string, unknown>) => string;

export type AboutClimbInput = {
  /** The name the heading shows, already resolved for an unnamed climb. */
  climbName: string;
  /** The climb's grade as stored (`"6c/V5"`), or null for an ungraded climb. */
  difficulty: string | null | undefined;
  /** The board and layout as one label, e.g. "Kilter Board Original". */
  boardLabel: string;
  angle: number;
  setter: string | null | undefined;
  /** The first ascent AT THIS ANGLE: the stats row is per angle, so it is never the climb's overall first. */
  firstAscentClimber: string | null | undefined;
  /** That first ascent's timestamp as the stats row carries it. */
  firstAscentAt: string | null | undefined;
  /** Sends logged at the angle being viewed. */
  sendsHere: number | string | null | undefined;
  /** Every angle the climb has stats for: the source of its easiest and hardest angle. */
  angleStats: ReadonlyArray<
    Pick<
      ClimbStatsForAngle,
      'angle' | 'difficulty' | 'display_difficulty' | 'difficulty_average' | 'ascensionist_count'
    >
  >;
};

type RankedAngle = { angle: number; grade: string; rank: number };

/**
 * The angles whose grade the stats can rank, easiest first. The rank is the
 * row's own difficulty number (`display_difficulty`, else the raw average), so
 * two angles with the same grade label still order honestly. A row with no
 * grade, no number or no sends has nothing to say about how the climb climbs
 * there (an angle nobody has sent carries only the setter's guess) and is left
 * out.
 */
function rankedAngles(angleStats: AboutClimbInput['angleStats']): RankedAngle[] {
  return angleStats
    .flatMap((stats) => {
      const rawRank = stats.display_difficulty ?? stats.difficulty_average;
      const rank = rawRank === null || rawRank === undefined ? Number.NaN : Number(rawRank);
      if (!stats.difficulty || !Number.isFinite(rank) || sendCount(stats.ascensionist_count) === 0) return [];
      return [{ angle: stats.angle, grade: climbGradeForSearch(stats.difficulty), rank }];
    })
    .sort((first, second) => first.rank - second.rank || first.angle - second.angle);
}

/**
 * The "About this climb" paragraph as whole translated sentences, built only
 * from facts already on the page.
 *
 * Each sentence states one thing and needs every value it names, so a missing
 * value drops its sentence instead of printing a hole: no setter means the
 * intro without "set by", no first-ascent date means no first-ascent sentence,
 * one grade across every angle means no range, and no sends means no count —
 * never "0 sends". Every sentence is one catalog string, so a locale orders its
 * own words; callers join them with `joinAboutSentences`.
 */
export function buildAboutSentences(input: AboutClimbInput, t: TranslateSentence, locale: string): string[] {
  const sentences: string[] = [];
  const grade = input.difficulty ? climbGradeForSearch(input.difficulty) : null;
  const setter = input.setter?.trim() || null;
  const placement = { climbName: input.climbName, board: input.boardLabel, angle: input.angle };

  if (grade) {
    sentences.push(
      setter
        ? t('frontDoor.about.introWithSetter', { ...placement, grade, setter })
        : t('frontDoor.about.intro', { ...placement, grade }),
    );
  } else {
    sentences.push(
      setter
        ? t('frontDoor.about.introUngradedWithSetter', { ...placement, setter })
        : t('frontDoor.about.introUngraded', placement),
    );
  }

  const firstAscentClimber = input.firstAscentClimber?.trim();
  const firstAscentDate = formatFirstAscentDate(input.firstAscentAt, locale);
  if (firstAscentClimber && firstAscentDate) {
    sentences.push(
      t('frontDoor.about.firstAscent', { climber: firstAscentClimber, angle: input.angle, date: firstAscentDate }),
    );
  }

  const ranked = rankedAngles(input.angleStats);
  const easiest = ranked.at(0);
  const hardest = ranked.at(-1);
  if (easiest && hardest && easiest.grade !== hardest.grade) {
    sentences.push(
      t('frontDoor.about.gradeRange', {
        easiest: easiest.grade,
        easiestAngle: easiest.angle,
        hardest: hardest.grade,
        hardestAngle: hardest.angle,
      }),
    );
  }

  const sendsHere = sendCount(input.sendsHere);
  if (sendsHere > 0) {
    sentences.push(
      t('frontDoor.about.sendsHere', {
        count: sendsHere,
        formattedCount: new Intl.NumberFormat(locale).format(sendsHere),
      }),
    );
  }

  return sentences;
}

/**
 * One paragraph from whole sentences. Chinese runs its sentences together with
 * no space (each already ends in "。"); the other locales use one space.
 */
export function joinAboutSentences(sentences: readonly string[], locale: string): string {
  return sentences.join(locale.startsWith('zh') ? '' : ' ');
}
