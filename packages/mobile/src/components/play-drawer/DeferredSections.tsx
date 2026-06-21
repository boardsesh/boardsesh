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
import { BetaVideosSection } from './BetaVideosSection';
import { useAuth } from '../../providers/auth-provider';
import { useTheme } from '../../providers/theme-provider';
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
  /** Reports the measured height of the Beta Videos section header (drives the play
   *  drawer's first-screen reserve so the header teases at the bottom of the fold). */
  onBetaHeaderLayout?: (height: number) => void;
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
  onBetaHeaderLayout,
  onAddBetaVideo,
}: DeferredSectionsProps) {
  const { t } = useTranslation('session');
  const { isAuthenticated } = useAuth();
  const { brandColors } = useTheme();

  const handleAddBetaVideoPress = useCallback(() => {
    void Haptics.selectionAsync();
    onAddBetaVideo?.();
  }, [onAddBetaVideo]);
  // Defer the JS-heavy below-fold sections until just after the drawer's open
  // animation and only after the user has started scrolling below the fold.
  // Beta videos stay eager below because their header/body is the user's first
  // scroll affordance once the drawer opens.
  // Re-defers per climb (resetKey = uuid) and — unlike a bare
  // runAfterInteractions — falls back to a bounded timeout, so a starved
  // interaction queue can't leave these sections blank until the drawer reopens.
  const readyToRender = useDeferredAfterInteractions(enabled && contentEnabled, climb.uuid);

  // Tally shown next to the collapsed Logbook header so the user sees their
  // history without expanding. Mirrors LogbookSection's summary fallback.
  const logbookSummary = useMemo(() => {
    const sends = climb.userAscents ?? 0;
    const attempts = climb.userAttempts ?? 0;
    if (sends > 0 && attempts > 0) return t('mobile.logbook.sendsAndAttempts', { sends, attempts });
    if (sends > 0) return t('mobile.logbook.sendsOnly', { sends });
    if (attempts > 0) return t('mobile.logbook.attemptsOnly', { attempts });
    return null;
  }, [climb.userAscents, climb.userAttempts, t]);

  if (!enabled) {
    return null;
  }

  // Keep Beta Videos eager so it can measure immediately and tease real content
  // at the bottom of the first screen. The heavier Logbook/Community/Similar
  // sections still wait for scroll + the interaction queue.
  return (
    <View style={styles.container}>
      <CollapsibleSection
        title={t('mobile.betaVideos.title')}
        keepExpanded
        onHeaderLayout={onBetaHeaderLayout}
        headerAction={
          isAuthenticated && onAddBetaVideo ? (
            <Pressable
              onPress={handleAddBetaVideoPress}
              accessibilityRole="button"
              accessibilityLabel={t('mobile.betaVideos.addButton')}
              hitSlop={8}
              style={({ pressed }) => [styles.addButton, pressed && { backgroundColor: `${brandColors.primary}1A` }]}
            >
              <Icon name="add" size={22} color={brandColors.primary} />
            </Pressable>
          ) : undefined
        }
      >
        <BetaVideosSection climbUuid={climb.uuid} boardName={boardName} />
      </CollapsibleSection>

      {readyToRender && (
        <>
          <CollapsibleSection title={t('mobile.logbook.title')} summary={logbookSummary}>
            <LogbookSection
              climbUuid={climb.uuid}
              boardName={boardName}
              userAscents={climb.userAscents}
              userAttempts={climb.userAttempts}
            />
          </CollapsibleSection>

          <CollapsibleSection title={t('mobile.community.title')} defaultExpanded>
            <CommunitySection
              climbUuid={climb.uuid}
              boardName={boardName}
              qualityAverage={climb.quality_average}
              ascensionistCount={climb.ascensionist_count}
            />
          </CollapsibleSection>

          <CollapsibleSection title={t('mobile.similarClimbs.title')}>
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
