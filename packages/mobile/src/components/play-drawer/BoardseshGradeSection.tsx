import { memo, useCallback, useMemo } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { DumbbellByAngleChart } from './DumbbellByAngleChart';
import { buildDumbbellByAngleModel } from './by-angle-comparison';
import { buildAngleGradeBars } from './community-utils';
import { useBoardseshGrade, useBoardseshGradesForAngles, useClimbStatsHistory } from '../../lib/graphql/hooks';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useIsOffline } from '../../hooks/use-is-offline';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { getBoardCapabilities } from '@boardsesh/board-config';
import { buildBoardseshGradeView, buildCorrection, buildTrustBand } from './boardsesh-grade-utils';
import { ESTIMATE_PREFIX, renderDifficulty } from '../../lib/boardsesh-grade-display';
import { useMyGrade } from '../../hooks/use-my-grade';
import { GradeValue, type GradeSource } from '../grade/GradeValue';
import type { IconName } from '../icon-map';
import type { GradeDisplayFormat } from '@boardsesh/play-view';

type BoardseshGradeSectionProps = {
  climbUuid: string;
  boardName: string;
  angle: number;
};

/**
 * One rung of the grade ladder: a provenance glyph, a wrapping label with an
 * optional detail line, and the grade itself pinned right.
 *
 * A vertical ladder rather than a third column in the shipped `correctionRow`
 * hero: that row is already two grades wide, and a label like "Angegebener
 * Grad" cannot sit beside "Boardsesh-Grad" at caption size without clipping.
 * Stacking lets each label wrap on its own.
 *
 * The grade slot is `GradeValue`'s `ladder` variant, which never marks: the
 * rung already states its provenance in words beside a 20pt glyph gutter, so a
 * marker on the number would be the third time one row says the same thing.
 */
const GradeLadderRow = memo(function GradeLadderRow({
  icon,
  source,
  label,
  detail,
  grade,
  gradeColor,
}: {
  icon: IconName;
  /** Whose grade this rung is. Carried for the slot's contract; never drawn here. */
  source: GradeSource;
  label: string;
  detail?: string | null;
  grade: string;
  /** Omitted for every rung except the one the app is actually using for you. */
  gradeColor?: string;
}) {
  const { systemColors } = useTheme();
  return (
    <View style={styles.ladderRow}>
      <View style={styles.ladderGlyph}>
        <Icon name={icon} size={16} color={iosSystemColors.systemGray} />
      </View>
      <View style={styles.ladderLabel}>
        <Text variant="subheadline">{label}</Text>
        {detail ? (
          <Text variant="caption1" color={iosSystemColors.systemGray}>
            {detail}
          </Text>
        ) : null}
      </View>
      <GradeValue label={grade} color={gradeColor ?? systemColors.secondaryLabel} source={source} variant="ladder" />
    </View>
  );
});

/**
 * The climber's own grade for this climb, and how it sits against the number
 * the app would otherwise show (#4796, #4828).
 *
 * Renders nothing but a teaching CTA when they haven't graded it — that empty
 * state is the direct answer to #4796's real complaint, which was that nothing
 * anywhere told them the grade field on the tick form was the lever.
 *
 * Exactly ONE grade in the ladder carries a grade-ramp colour: the one the app
 * is using for you. Colouring every rung would make three numbers compete when
 * only one of them is answering the question "what grade is this climb".
 */
const YourGradeBlock = memo(function YourGradeBlock({
  climbUuid,
  angle,
  crowdLabel,
  boardSetsTheGrade,
  gradeFormat,
}: {
  climbUuid: string;
  angle: number;
  /** The grade the app would show without a personal one. Null where the board has none. */
  crowdLabel: string | null;
  /** True on Woods/MoonBoard, where the "crowd" number is really the setter's own. */
  boardSetsTheGrade: boolean;
  gradeFormat: GradeDisplayFormat;
}) {
  const { t } = useTranslation('climbs');
  const { brandColors } = useTheme();
  const myGrade = useMyGrade(climbUuid, angle);
  const mine = myGrade.status === 'set' ? renderDifficulty(myGrade.difficultyId, gradeFormat) : null;

  if (!mine) {
    // Never render the CTA while the logbook is still unknown — it would
    // invite someone to grade a climb they may already have graded.
    if (myGrade.status !== 'none') return null;
    return (
      <View style={styles.row}>
        <Icon name="add.fill" size={20} color={brandColors.primary} />
        <Text variant="subheadline" color={brandColors.primary} style={styles.flexText}>
          {t('boardseshGrade.yours.emptyBody')}
        </Text>
      </View>
    );
  }

  const agrees = crowdLabel != null && crowdLabel === mine.label;
  return (
    <View style={styles.ladder}>
      <GradeLadderRow
        icon="person"
        source="personal"
        label={t('boardseshGrade.yours.label')}
        detail={t('boardseshGrade.yours.meta', { angle })}
        grade={mine.label}
        gradeColor={mine.color}
      />
      {crowdLabel ? (
        <GradeLadderRow
          icon="people"
          source="crowd"
          // On Woods and MoonBoard the number comes straight out of the
          // manufacturer's own app, so calling it a "community grade" would be
          // a lie. "Board grade" rather than "Setter's grade" because the data
          // carries no setter attribution to claim — and rather than the
          // earlier "Set at", which read as a date and which the French and
          // German translators each resolved differently, proving it ambiguous.
          label={boardSetsTheGrade ? t('boardseshGrade.yours.boardGrade') : t('boardseshGrade.yours.community')}
          grade={crowdLabel}
        />
      ) : null}
      {agrees ? (
        <Text variant="footnote" color={iosSystemColors.systemGray}>
          {t('boardseshGrade.yours.matches')}
        </Text>
      ) : null}
    </View>
  );
});

export const BoardseshGradeSection = memo(function BoardseshGradeSection({
  climbUuid,
  boardName,
  angle,
}: BoardseshGradeSectionProps) {
  const { t } = useTranslation('climbs');
  const { t: tCommon } = useTranslation('common');
  const { gradeFormat } = useGradeFormat();
  const { brandColors } = useTheme();
  // The cheap boolean, not the whole snapshot — see BetaVideosSection: a memo'd
  // drawer section must not re-render on every probe tick.
  const effectiveOffline = useIsOffline();

  // MoonBoard and Woods have no community grade data in our feed, so skip the
  // fetch (see the crowdGrade row of the board-capability table).
  const noCrowdGrade = !getBoardCapabilities(boardName).crowdGrade;
  const {
    data: grade,
    isLoading,
    isError,
    refetch,
  } = useBoardseshGrade(boardName, climbUuid, angle, {
    enabled: !noCrowdGrade,
  });

  const view = useMemo(
    () => buildBoardseshGradeView(boardName, grade ?? null, gradeFormat),
    [boardName, grade, gradeFormat],
  );

  // Progressive enhancement — the crowd (community) series feeds the hero's
  // "this board" number and the dumbbell's rings. Loading/error render nothing;
  // the section's own loading/error stays owned by the singular grade above.
  const { data: history } = useClimbStatsHistory(boardName, noCrowdGrade ? null : climbUuid);
  const crowdBars = useMemo(() => buildAngleGradeBars(history, gradeFormat), [history, gradeFormat]);
  const crowdDifficulty = useMemo(
    () => crowdBars.find((bar) => bar.angle === angle)?.difficulty ?? null,
    [crowdBars, angle],
  );

  // The cross-board Boardsesh series per angle → the dumbbell's diamonds.
  const { data: angleRows } = useBoardseshGradesForAngles(boardName, climbUuid, { enabled: !noCrowdGrade });
  const dumbbellRows = useMemo(
    () => buildDumbbellByAngleModel(angleRows ?? [], crowdBars, gradeFormat),
    [angleRows, crowdBars, gradeFormat],
  );

  // The correction only exists for a real cross-board grade with a crowd number
  // at this angle. Setter-only / no-crowd-grade / local-only never carry one.
  const correction = useMemo(() => {
    if (view.kind !== 'confirmed' && view.kind !== 'provisional') return null;
    if (!view.universal) return null;
    return buildCorrection(crowdDifficulty, view.gradeValue, gradeFormat);
  }, [view, crowdDifficulty, gradeFormat]);

  const handleRetry = useCallback(() => {
    void Haptics.selectionAsync();
    void refetch();
  }, [refetch]);

  if (!noCrowdGrade && isLoading) {
    return <View style={[styles.skeleton, styles.skeletonBlock]} />;
  }

  // Nothing can reach us and no grade is cached. A tappable "Couldn't load"
  // row invites a retry that cannot land, and falling through to the
  // setter-only view would assert something we never got to ask about. One
  // muted line instead — the global connectivity banner owns the recovery.
  if (!noCrowdGrade && effectiveOffline && !grade) {
    return (
      <View style={styles.row}>
        <Text variant="subheadline" color={iosSystemColors.systemGray}>
          {tCommon('mobile.connectivity.needsConnection')}
        </Text>
      </View>
    );
  }

  if (!noCrowdGrade && isError) {
    return (
      <Pressable
        onPress={handleRetry}
        style={styles.row}
        accessibilityRole="button"
        accessibilityLabel={t('boardseshGrade.loadError')}
      >
        <Icon name="refresh" size={20} color={brandColors.primary} />
        <Text variant="subheadline" color={brandColors.primary}>
          {t('boardseshGrade.loadError')}
        </Text>
      </Pressable>
    );
  }

  if (view.kind === 'noCrowdGrade') {
    // This branch is everything a Woods or MoonBoard climber sees — i.e. all
    // either reporter of #4796/#4828 ever saw. Their own grade goes ABOVE the
    // "no community data" line, because on these boards it is the only grade
    // anyone has actually pulled on.
    return (
      <View style={styles.container}>
        <YourGradeBlock
          climbUuid={climbUuid}
          angle={angle}
          crowdLabel={null}
          boardSetsTheGrade
          gradeFormat={gradeFormat}
        />
        <View style={styles.row}>
          <Icon name="info" size={20} color={iosSystemColors.systemGray} />
          <Text variant="subheadline" color={iosSystemColors.systemGray} style={styles.flexText}>
            {/* Literal keys per board — the i18n linter rejects a computed t() key. */}
            {view.boardName === 'woods' ? t('boardseshGrade.woodsBody') : t('boardseshGrade.moonboardBody')}
          </Text>
        </View>
      </View>
    );
  }

  if (view.kind === 'crossAngle') {
    // Nobody has climbed this angle. Show the projection, marked: `≈` on the
    // number, the grade colour kept (colour is content — see the design
    // guidelines), but one type size down from a measured grade, no confirmed
    // seal, and a sentence saying plainly where the number came from. The
    // by-angle chart stays, because it's the thing that makes the estimate
    // legible — the real angles are right there next to the projected one.
    return (
      <View style={styles.container}>
        <View style={styles.singleHero}>
          <Text variant="caption1" color={iosSystemColors.systemGray}>
            {t('boardseshGrade.estimate.label')}
          </Text>
          <Text variant="title1" style={[styles.gradeValue, styles.estimateGrade, { color: view.grade.color }]}>
            {`${ESTIMATE_PREFIX}${view.grade.label}`}
          </Text>
        </View>
        <View style={styles.row}>
          <Icon name="angle" size={18} color={iosSystemColors.systemGray} />
          <Text variant="footnote" color={iosSystemColors.systemGray} style={styles.flexText}>
            {view.range
              ? t('boardseshGrade.estimate.bodyRange', { low: view.range.low, high: view.range.high })
              : t('boardseshGrade.estimate.body')}
          </Text>
        </View>
        {dumbbellRows.length >= 1 && (
          <View style={styles.histogram}>
            <DumbbellByAngleChart
              rows={dumbbellRows}
              headlineGrade={view.gradeValue}
              gradeFormat={gradeFormat}
              accessibilityLabel={t('boardseshGrade.byAngle')}
            />
          </View>
        )}
      </View>
    );
  }

  if (view.kind === 'setterOnly') {
    return (
      <View style={styles.container}>
        <View style={styles.setterHero}>
          <Text variant="caption1" color={iosSystemColors.systemGray}>
            {t('boardseshGrade.setterCall')}
          </Text>
          {view.grade && (
            <Text variant="title1" style={[styles.gradeValue, styles.setterGrade]}>
              {view.grade.label}
            </Text>
          )}
        </View>
        <Text variant="footnote" color={iosSystemColors.systemGray}>
          {t('boardseshGrade.trust.setter')}
        </Text>
      </View>
    );
  }

  // Confirmed / provisional from here down. Everything the hero + trust rows
  // need is projected off the narrowed `view` here in the main body — the JSX
  // below reads only these primitives, so TS's narrowing survives (it drops
  // inside nested closures) and the render stays a flat, memo-clean tree.
  const provisional = view.kind === 'provisional';
  const universal = view.universal;
  const heroGrade = view.grade;
  const showConfirmedSeal = view.kind === 'confirmed' && view.universal;
  const rangeLabel = view.kind === 'provisional' ? view.rangeLabel : null;
  const count = view.count;
  // Low/high labels for the trust line. When both bounds round to the same grade
  // there is no real range ("V4–V4"), so we show a single-grade line instead.
  const band = buildTrustBand(view.gradeLow, view.gradeHigh, heroGrade.label, gradeFormat);
  // The all-boards grade shows the two-grade span for a provisional read.
  const everywhereLabel = rangeLabel ?? heroGrade.label;
  // "About ½" for a provisional payoff; "½" when confirmed.
  const amount = correction?.label
    ? provisional
      ? t('boardseshGrade.hero.approx', { amount: correction.label })
      : correction.label
    : null;

  const seal = showConfirmedSeal ? (
    <Icon name="checkmark.seal.fill" size={22} color={iosSystemColors.systemGreen} />
  ) : null;

  return (
    <View style={styles.container}>
      {/* YOUR GRADE — above the hero, because it is the number the rest of the
          app is now actually showing you. The hero below still explains where
          the crowd's and the cross-board grades came from. */}
      <YourGradeBlock
        climbUuid={climbUuid}
        angle={angle}
        crowdLabel={correction?.crowd.label ?? null}
        boardSetsTheGrade={false}
        gradeFormat={gradeFormat}
      />
      {/* HERO — leads left→right with the cross-board correction. */}
      {!universal ? (
        // Local-only: no cross-board number yet — one centred grade, no comparison.
        <View style={styles.singleHero}>
          <Text variant="caption1" color={iosSystemColors.systemGray}>
            {t('boardseshGrade.hero.thisBoardOnly')}
          </Text>
          <Text variant="largeTitle" style={[styles.gradeValue, { color: heroGrade.color }]}>
            {everywhereLabel}
          </Text>
          <Text variant="footnote" color={iosSystemColors.systemGray} style={styles.centered}>
            {t('boardseshGrade.localOnlyNote')}
          </Text>
        </View>
      ) : correction && correction.direction === 'equal' ? (
        // Crowd rounds equal to the cross-board grade: drop the comparison, say so.
        <View style={styles.singleHero}>
          <View style={styles.everywhereValue}>
            <Text variant="largeTitle" style={[styles.gradeValue, { color: heroGrade.color }]}>
              {everywhereLabel}
            </Text>
            {seal}
          </View>
          <Text variant="footnote" color={iosSystemColors.systemGray} style={styles.centered}>
            {t('boardseshGrade.matchesBoard')}
          </Text>
        </View>
      ) : !correction ? (
        // No crowd grade at this angle: show the cross-board grade alone.
        <View style={styles.singleHero}>
          <Text variant="caption1" color={iosSystemColors.systemGray}>
            {t('boardseshGrade.hero.everywhere')}
          </Text>
          <View style={styles.everywhereValue}>
            <Text variant="largeTitle" style={[styles.gradeValue, { color: heroGrade.color }]}>
              {everywhereLabel}
            </Text>
            {seal}
          </View>
        </View>
      ) : (
        // Full correction: [THIS BOARD crowd] → [arrow] → [ALL BOARDS Boardsesh ✓].
        // The grey→coloured grades + the single payoff sentence carry the delta.
        <View style={styles.correctionRow}>
          <View style={styles.correctionSide}>
            <Text variant="caption1" color={iosSystemColors.systemGray}>
              {t('boardseshGrade.hero.thisBoard')}
            </Text>
            <Text variant="title1" style={[styles.gradeValue, styles.crowdGrade]}>
              {correction.crowd.label}
            </Text>
          </View>

          <View style={styles.correctionArrow}>
            <Icon name="arrow.right" size={18} color={iosSystemColors.systemGray} />
          </View>

          <View style={styles.correctionSide}>
            <Text variant="caption1" color={iosSystemColors.systemGray}>
              {t('boardseshGrade.hero.everywhere')}
            </Text>
            <View style={styles.everywhereValue}>
              <Text variant="largeTitle" style={[styles.gradeValue, { color: heroGrade.color }]}>
                {everywhereLabel}
              </Text>
              {seal}
            </View>
          </View>
        </View>
      )}

      {/* PAYOFF — softer/stiffer voice, in one line under the hero. Suppressed on
          the equal tier: the hero's "matches this board" note already says it, so
          a payoff row here would just repeat it. */}
      {correction && correction.direction !== 'equal' && (
        <View style={styles.payoffRow}>
          <View style={[styles.accentBar, { backgroundColor: brandColors.primary }]} />
          <Text variant="subheadline" style={styles.flexText}>
            {t(correction.direction === 'easier' ? 'boardseshGrade.payoff.softer' : 'boardseshGrade.payoff.stiffer', {
              amount,
            })}
          </Text>
        </View>
      )}

      {/* TRUST — the sample + (only a real) band on one line. A range collapses to
          a single-grade line when both bounds round to the same grade. */}
      {provisional ? (
        <Text variant="footnote" color={iosSystemColors.systemOrange}>
          {band.sameLabel
            ? t('boardseshGrade.trust.provisionalSingle', { count })
            : t('boardseshGrade.trust.provisionalRange', { low: band.low, high: band.high, count })}
        </Text>
      ) : (
        <View style={styles.trustRow}>
          <Icon name="check.small" size={14} color={iosSystemColors.systemGreen} />
          <Text variant="footnote" color={iosSystemColors.systemGray} style={styles.flexText}>
            {band.sameLabel
              ? t('boardseshGrade.trust.confirmedSingle', { count })
              : t('boardseshGrade.trust.confirmedRange', { low: band.low, high: band.high, count })}
          </Text>
        </View>
      )}

      {/* DUMBBELL — crowd rings vs Boardsesh diamonds, one per angle. */}
      {dumbbellRows.length >= 1 && (
        <View style={styles.histogram}>
          <DumbbellByAngleChart
            rows={dumbbellRows}
            headlineGrade={view.gradeValue}
            gradeFormat={gradeFormat}
            accessibilityLabel={t('boardseshGrade.byAngle')}
          />
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: spacing[3],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  flexText: {
    flex: 1,
  },
  centered: {
    textAlign: 'center',
  },
  gradeValue: {
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  // YOUR GRADE — the vertical ladder above the hero
  ladder: {
    gap: spacing[3],
  },
  ladderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[2],
  },
  ladderGlyph: {
    // Fixed width so every rung's label starts on the same vertical line,
    // whatever glyph sits in front of it.
    width: 20,
    alignItems: 'center',
    paddingTop: 2,
  },
  ladderLabel: {
    flex: 1,
    // Without an explicit floor a flex child refuses to shrink below its
    // content, so a long localized label would push the grade off the row
    // instead of wrapping.
    minWidth: 0,
    gap: 1,
  },
  // HERO — correction row
  correctionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[2],
  },
  correctionSide: {
    alignItems: 'center',
    gap: spacing[1],
  },
  crowdGrade: {
    color: iosSystemColors.systemGray,
  },
  correctionArrow: {
    alignItems: 'center',
    gap: spacing[1],
  },
  everywhereValue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  // HERO — single-grade layouts (local-only / matches / no-crowd)
  singleHero: {
    alignItems: 'center',
    gap: spacing[1],
  },
  // HERO — setter-only
  setterHero: {
    gap: spacing[1],
  },
  setterGrade: {
    color: iosSystemColors.systemGray,
  },
  // HERO — projected angle. Keeps the grade colour (colour is content) but sits
  // a size down from a measured grade and never carries the confirmed seal.
  estimateGrade: {
    opacity: 0.75,
  },
  // PAYOFF
  payoffRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[2],
  },
  accentBar: {
    width: 2,
    alignSelf: 'stretch',
    borderRadius: 1,
  },
  // TRUST
  trustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  histogram: {
    gap: spacing[2],
  },
  skeleton: {
    borderRadius: borderRadius.md,
    backgroundColor: `${iosSystemColors.systemGray}14`,
  },
  skeletonBlock: {
    height: spacing[10],
  },
});
