import { memo, useCallback, useMemo } from 'react';
import { View, Pressable, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { useLogbook } from '@boardsesh/board-react';
import { getBoardCapabilities } from '@boardsesh/board-config';
import { deriveOtherAngleActivity } from './logbook-summary';
import { CollapsibleSection } from '../CollapsibleSection';
import { Icon } from '../Icon';
import { LogbookSection } from './LogbookSection';
import { SimilarClimbsSection } from './SimilarClimbsSection';
import { CommunitySection } from './CommunitySection';
import { BoardseshGradeSection } from './BoardseshGradeSection';
import { buildBoardseshGradeView, buildBoardseshGradeSummary } from './boardsesh-grade-utils';
import { buildAngleGradeBars } from './community-utils';
import { BetaVideosSection } from './BetaVideosSection';
import { SetterNotesSection } from './SetterNotesSection';
import { useAuth } from '../../providers/auth-provider';
import { useBoardseshGradeEnabled } from '../../providers/feature-flags-provider';
import { useTheme } from '../../providers/theme-provider';
import { useBoardseshGrade, useClimbStatsHistory } from '../../lib/graphql/hooks';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { spacing, borderRadius } from '../../theme/tokens';
import { useDeferredAfterInteractions } from '../../hooks/use-deferred-after-interactions';
import { BETA_SHELF_SECTION_KEY } from '../../lib/beta-shelf-collapse';

type DeferredSectionsProps = {
  climb: Climb;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  enabled: boolean;
  contentEnabled: boolean;
  onSimilarClimbPress: (climb: Climb) => void;
  /** Reports the measured height of the Logbook section header (drives the play
   *  drawer's first-screen reserve so the header teases at the bottom of the fold). */
  onLogbookHeaderLayout?: (height: number) => void;
  /** Reports the measured height of the whole Logbook section (header + expanded
   *  body). Lets the play drawer scroll a deliberate expand fully into view. */
  onLogbookSectionLayout?: (height: number) => void;
  /** Fires when the user taps to expand/collapse the Logbook (not on mount), with
   *  the new state — the play drawer scrolls the section into view on expand. */
  onLogbookToggle?: (expanded: boolean) => void;
  /** Opens the "share your beta" sheet. Rendered as the Beta Videos header "+" for
   *  signed-in users; absent (undefined) hides it. */
  onAddBetaVideo?: () => void;
};

/**
 * Below-fold deferred content for the play drawer.
 * Uses InteractionManager.runAfterInteractions() to defer rendering
 * until after the drawer open animation completes, preventing jank.
 */
export const DeferredSections = memo(function DeferredSections({
  climb,
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  enabled,
  contentEnabled,
  onSimilarClimbPress,
  onLogbookHeaderLayout,
  onLogbookSectionLayout,
  onLogbookToggle,
  onAddBetaVideo,
}: DeferredSectionsProps) {
  const { t } = useTranslation('session');
  const { t: tClimbs } = useTranslation('climbs');
  const { isAuthenticated } = useAuth();
  const { brandColors } = useTheme();
  const { gradeFormat } = useGradeFormat();
  const boardseshGradeEnabled = useBoardseshGradeEnabled();

  const handleAddBetaVideoPress = useCallback(() => {
    void Haptics.selectionAsync();
    onAddBetaVideo?.();
  }, [onAddBetaVideo]);

  const handleLogbookSectionLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onLogbookSectionLayout?.(event.nativeEvent.layout.height);
    },
    [onLogbookSectionLayout],
  );
  // Defer the JS-heavy below-fold sections until just after the drawer's open
  // animation and only after the user has started scrolling below the fold.
  // The Logbook stays eager above because its collapsed header is the scroll
  // hint at the bottom of the first screen — it must measure immediately.
  // Re-defers per climb (resetKey = uuid) and — unlike a bare
  // runAfterInteractions — falls back to a bounded timeout, so a starved
  // interaction queue can't leave these sections blank until the drawer reopens.
  const readyToRender = useDeferredAfterInteractions(enabled && contentEnabled, climb.uuid);

  // The climber's ticks for this climb across every angle. Fed to the summary's
  // cross-angle clause below. Reading it here is eager (one fetch per climb on
  // open), but React Query dedupes it with LogbookSection's identical fetch, so
  // it never doubles up; it stays empty until it lands, and the summary just
  // drops the clause meanwhile.
  const { logbook } = useLogbook(boardName as BoardName, [climb.uuid]);
  const otherAngleActivity = useMemo(() => {
    const entriesForClimb = logbook.filter((entry) => entry.climb_uuid === climb.uuid);
    return deriveOtherAngleActivity(entriesForClimb, angle);
  }, [logbook, climb.uuid, angle]);

  // The one-line summary on the collapsed Logbook header — the scroll hint the
  // user peeks at the fold. The current-angle counts read the denormalised
  // userAscents/userAttempts (both angle-scoped, disjoint), so the line renders
  // and measures instantly. Prefixed with the board's angle, then — once the
  // logbook lands — a concise clause flags other angles the climb was sent or
  // only tried at (a send always leads; 3+ angles collapse to a count).
  const logbookSummary = useMemo(() => {
    // Logged-out visitors have no logbook, so "not tried yet" would be a lie —
    // show no subtitle at all. The section body carries the sign-in line instead
    // (LogbookSection's signed-out branch).
    if (!isAuthenticated) return null;
    const sends = climb.userAscents ?? 0;
    const attempts = climb.userAttempts ?? 0;
    const sendsLabel = t('mobile.logbook.sendCount', { count: sends });
    const attemptsLabel = t('mobile.logbook.attemptCount', { count: attempts });
    let body: string;
    if (sends > 0 && attempts > 0)
      body = t('mobile.logbook.summarySendsAndAttempts', { sends: sendsLabel, attempts: attemptsLabel });
    else if (sends > 0) body = sendsLabel;
    // Attempts but no send yet — the "how often did I fight this" case, named as
    // unfinished business to invite the return.
    else if (attempts > 0) body = t('mobile.logbook.summaryAttemptsNoSend', { attempts: attemptsLabel });
    else body = t('mobile.logbook.summaryUntried');

    const line = t('mobile.logbook.summaryAnglePrefix', { angle, body });

    const { sentAngles, triedAngles } = otherAngleActivity;
    const formatAngles = (angles: number[]) => angles.map((otherAngle) => `${otherAngle}°`).join(', ');
    // At most 2 angles inline, then collapse to a count so the one line stays
    // scannable. A send elsewhere is the achievement, so its clause leads.
    const sentClause =
      sentAngles.length === 0
        ? null
        : sentAngles.length <= 2
          ? t('mobile.logbook.otherAnglesSent', { angles: formatAngles(sentAngles) })
          : t('mobile.logbook.otherAnglesSentCount', { count: sentAngles.length });
    const triedClause =
      triedAngles.length === 0
        ? null
        : triedAngles.length <= 2
          ? t('mobile.logbook.otherAnglesTried', { angles: formatAngles(triedAngles) })
          : t('mobile.logbook.otherAnglesTriedCount', { count: triedAngles.length });
    const clause = [sentClause, triedClause].filter(Boolean).join(' · ');

    return clause ? t('mobile.logbook.summaryWithOtherAngles', { body: line, clause }) : line;
  }, [isAuthenticated, climb.userAscents, climb.userAttempts, angle, otherAngleActivity, t]);

  // Grade shown next to the collapsed Boardsesh grade header. Lifted up here
  // (rather than read from BoardseshGradeSection) because that section
  // unmounts while collapsed — React Query dedupes this fetch with the
  // section's identical-key one once it expands, so this costs no extra request.
  // MoonBoard and Woods carry no crowd grade, so the Boardsesh-grade and
  // stats-history queries below have nothing to answer with — skip them for
  // both. (BoardseshGradeSection gates its own by-angle query the same way.)
  const noCrowdGrade = !getBoardCapabilities(boardName).crowdGrade;
  const boardseshReady = boardseshGradeEnabled && !noCrowdGrade && readyToRender;
  const { data: boardseshGrade } = useBoardseshGrade(boardName, climb.uuid, angle, {
    enabled: boardseshReady,
  });
  // The crowd grade at this angle turns the teaser into the correction "V4 ▸ V3+ ✓".
  // React Query dedupes this with CommunitySection's identical fetch, so it costs
  // no extra request; it stays null until loaded and the teaser drops the "V4 ▸".
  const { data: history } = useClimbStatsHistory(boardName, boardseshReady ? climb.uuid : null);
  const boardseshSummary = useMemo(() => {
    const view = buildBoardseshGradeView(boardName, boardseshGrade ?? null, gradeFormat);
    const crowdLabel = buildAngleGradeBars(history, gradeFormat).find((bar) => bar.angle === angle)?.gradeName ?? null;
    return buildBoardseshGradeSummary(view, { crowdLabel, localWord: tClimbs('boardseshGrade.summaryLocal') });
  }, [boardName, boardseshGrade, gradeFormat, history, angle, tClimbs]);

  if (!enabled) {
    return null;
  }

  // Keep the Logbook eager and collapsed so its one-line header (sends/attempts)
  // measures immediately and teases as the scroll hint at the bottom of the first
  // screen. The per-angle history mounts only when the user expands it. The
  // heavier Beta/Community/Similar sections still wait for scroll + the
  // interaction queue.
  return (
    <View style={styles.container}>
      {/* Wrapper measures the whole section (header + expanded body) so the play
          drawer can smoothly scroll a deliberate expand fully into view. */}
      <View onLayout={onLogbookSectionLayout ? handleLogbookSectionLayout : undefined}>
        <CollapsibleSection
          title={t('mobile.logbook.title')}
          summary={logbookSummary}
          persistKey="logbook"
          onHeaderLayout={onLogbookHeaderLayout}
          onToggle={onLogbookToggle}
        >
          <LogbookSection
            climbUuid={climb.uuid}
            boardName={boardName}
            userAscents={climb.userAscents}
            userAttempts={climb.userAttempts}
          />
        </CollapsibleSection>
      </View>

      {readyToRender && (
        <>
          {/* The setter's own notes. First below-fold section AFTER the Logbook,
              never before it: PlayDrawer's `firstScreenReserve` /
              `computeLogbookScrollTarget` assume the Logbook is the first
              section here, so anything inserted above it breaks the fold math.
              Renders nothing when the climb has no notes worth showing. */}
          <SetterNotesSection description={climb.description} />

          <CollapsibleSection
            title={t('mobile.betaVideos.title')}
            defaultExpanded
            persistKey={BETA_SHELF_SECTION_KEY}
            headerAction={
              isAuthenticated && onAddBetaVideo ? (
                <Pressable
                  onPress={handleAddBetaVideoPress}
                  accessibilityRole="button"
                  accessibilityLabel={t('mobile.betaVideos.addButton')}
                  hitSlop={8}
                  style={({ pressed }) => [
                    styles.addButton,
                    pressed && { backgroundColor: `${brandColors.primary}1A` },
                  ]}
                >
                  <Icon name="add" size={22} color={brandColors.primary} />
                </Pressable>
              ) : undefined
            }
          >
            <BetaVideosSection climbUuid={climb.uuid} boardName={boardName} />
          </CollapsibleSection>

          {boardseshGradeEnabled && (
            <CollapsibleSection
              title={tClimbs('boardseshGrade.title')}
              summary={boardseshSummary}
              defaultExpanded
              persistKey="boardseshGrade"
            >
              <BoardseshGradeSection climbUuid={climb.uuid} boardName={boardName} angle={angle} />
            </CollapsibleSection>
          )}

          <CollapsibleSection title={t('mobile.community.title')} defaultExpanded persistKey="community">
            <CommunitySection
              climbUuid={climb.uuid}
              boardName={boardName}
              layoutId={layoutId}
              angle={angle}
              qualityAverage={climb.quality_average}
              ascensionistCount={climb.ascensionist_count}
              isHidden={climb.is_hidden === true}
            />
          </CollapsibleSection>

          <CollapsibleSection title={t('mobile.similarClimbs.title')} persistKey="similarClimbs">
            <SimilarClimbsSection
              climbUuid={climb.uuid}
              boardName={boardName}
              layoutId={layoutId}
              sizeId={sizeId}
              setIds={setIds}
              angle={angle}
              onClimbPress={onSimilarClimbPress}
            />
          </CollapsibleSection>
        </>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[4],
  },
  addButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.full,
  },
});
