import { memo, useCallback, useMemo } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Haptics from 'expo-haptics';
import type { Climb } from '@boardsesh/shared-schema';
import { CollapsibleSection } from '../CollapsibleSection';
import { Icon } from '../Icon';
import { LogbookSection } from './LogbookSection';
import { SimilarClimbsSection } from './SimilarClimbsSection';
import { CommunitySection } from './CommunitySection';
import { BoardseshGradeSection } from './BoardseshGradeSection';
import { buildBoardseshGradeView, buildBoardseshGradeSummary, isMoonBoard } from './boardsesh-grade-utils';
import { buildAngleGradeBars } from './community-utils';
import { BetaVideosSection } from './BetaVideosSection';
import { useAuth } from '../../providers/auth-provider';
import { useBoardseshGradeEnabled } from '../../providers/feature-flags-provider';
import { useTheme } from '../../providers/theme-provider';
import { useBoardseshGrade, useClimbStatsHistory } from '../../lib/graphql/hooks';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { spacing, borderRadius } from '../../theme/tokens';
import { useDeferredAfterInteractions } from '../../hooks/use-deferred-after-interactions';

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
  // Defer the JS-heavy below-fold sections until just after the drawer's open
  // animation and only after the user has started scrolling below the fold.
  // The Logbook stays eager above because its collapsed header is the scroll
  // hint at the bottom of the first screen — it must measure immediately.
  // Re-defers per climb (resetKey = uuid) and — unlike a bare
  // runAfterInteractions — falls back to a bounded timeout, so a starved
  // interaction queue can't leave these sections blank until the drawer reopens.
  const readyToRender = useDeferredAfterInteractions(enabled && contentEnabled, climb.uuid);

  // The one-line sends/attempts tally shown on the collapsed Logbook header — the
  // scroll hint the user peeks at the fold. Reads the denormalised
  // userAscents/userAttempts counts (both angle-scoped, disjoint), so it renders
  // and measures instantly without waiting on the logbook fetch. Sends and
  // attempts pluralize individually, then compose so a locale owns the joining.
  const logbookSummary = useMemo(() => {
    const sends = climb.userAscents ?? 0;
    const attempts = climb.userAttempts ?? 0;
    const sendsLabel = t('mobile.logbook.sendCount', { count: sends });
    const attemptsLabel = t('mobile.logbook.attemptCount', { count: attempts });
    if (sends > 0 && attempts > 0)
      return t('mobile.logbook.summarySendsAndAttempts', { sends: sendsLabel, attempts: attemptsLabel });
    if (sends > 0) return sendsLabel;
    // Attempts but no send yet — the "how often did I fight this" case, named as
    // unfinished business to invite the return.
    if (attempts > 0) return t('mobile.logbook.summaryAttemptsNoSend', { attempts: attemptsLabel });
    return t('mobile.logbook.summaryUntried');
  }, [climb.userAscents, climb.userAttempts, t]);

  // Grade shown next to the collapsed Boardsesh grade header. Lifted up here
  // (rather than read from BoardseshGradeSection) because that section
  // unmounts while collapsed — React Query dedupes this fetch with the
  // section's identical-key one once it expands, so this costs no extra request.
  const moonboard = isMoonBoard(boardName);
  const boardseshReady = boardseshGradeEnabled && !moonboard && readyToRender;
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
      <CollapsibleSection
        title={t('mobile.logbook.title')}
        summary={logbookSummary}
        persistKey="logbook"
        onHeaderLayout={onLogbookHeaderLayout}
      >
        <LogbookSection
          climbUuid={climb.uuid}
          boardName={boardName}
          userAscents={climb.userAscents}
          userAttempts={climb.userAttempts}
        />
      </CollapsibleSection>

      {readyToRender && (
        <>
          <CollapsibleSection
            title={t('mobile.betaVideos.title')}
            keepExpanded
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
              qualityAverage={climb.quality_average}
              ascensionistCount={climb.ascensionist_count}
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
