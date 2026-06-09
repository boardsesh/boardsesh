import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '../Button';
import { GlassSurface } from '../GlassSurface';
import { OnboardingCard } from './OnboardingCard';
import { OnboardingPageControl } from './OnboardingPageControl';
import { ONBOARDING_CARDS, type OnboardingCard as OnboardingCardData } from '../../lib/onboarding/onboarding-cards';
import { useOnboardingCopy } from '../../lib/onboarding/use-onboarding-copy';
import {
  trackStepAdvanced,
  trackStepViewed,
  trackTourCompleted,
  trackTourSkipped,
  trackTourStarted,
} from '../../lib/onboarding/onboarding-analytics';
import { hapticSelection } from '../../lib/haptics';
import { useTheme } from '../../providers/theme-provider';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { spacing } from '../../theme/tokens';

type OnboardingCarouselProps = {
  /** Active dot + final CTA accent (HIG: systemColors.accent; Material: colors.primary). */
  accentColor: string;
  /** Illustration glyph tint. */
  iconColor: string;
  /** Inactive dot colour. */
  inactiveDotColor: string;
  /** Body/subtext colour. */
  bodyColor: string;
  /** Opaque background under the reading text. */
  backgroundColor: string;
  /** Skip (all but last) or completing the tour — both dismiss to the Climbs tab. */
  onDone: () => void;
  /** Final CTA — go connect a board. */
  onFinish: () => void;
};

const LAST_INDEX = ONBOARDING_CARDS.length - 1;

const keyExtractor = (card: OnboardingCardData) => card.id;

/**
 * Variant-agnostic 4-card welcome carousel. The route injects the resolved
 * colours and the two exits, so this component is identical for the HIG and
 * Material skins — the route picks the palette from the active variant.
 *
 * Paging: a horizontal `pagingEnabled` FlatList (virtualized; no `.map()` in a
 * ScrollView). Under Reduce Motion the list is locked (`scrollEnabled=false`)
 * and the Next button cross-fades pages via `scrollToIndex({ animated: false })`
 * instead of sliding.
 */
export function OnboardingCarousel({
  accentColor,
  iconColor,
  inactiveDotColor,
  bodyColor,
  backgroundColor,
  onDone,
  onFinish,
}: OnboardingCarouselProps) {
  const { t } = useTranslation('common');
  const copy = useOnboardingCopy();
  const insets = useSafeAreaInsets();
  const { variant } = useTheme();
  const reduceMotion = useReduceMotion();
  const listRef = useRef<FlatList<OnboardingCardData>>(null);

  const [pageWidth, setPageWidth] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  // Live mirror so the momentum-scroll handler can compare against the current
  // page without re-binding on every index change.
  const activeIndexRef = useRef(0);
  activeIndexRef.current = activeIndex;
  const startedAtRef = useRef<number>(Date.now());

  // Tour Started + first Step Viewed fire once on mount.
  useEffect(() => {
    startedAtRef.current = Date.now();
    trackTourStarted();
    trackStepViewed(ONBOARDING_CARDS[0], 0);
  }, []);

  const goToIndex = useCallback((nextIndex: number, trigger: 'next' | 'swipe') => {
    const fromIndex = activeIndexRef.current;
    if (nextIndex === fromIndex || nextIndex < 0 || nextIndex > LAST_INDEX) return;
    hapticSelection();
    setActiveIndex(nextIndex);
    trackStepAdvanced(ONBOARDING_CARDS[fromIndex], ONBOARDING_CARDS[nextIndex], trigger);
    trackStepViewed(ONBOARDING_CARDS[nextIndex], nextIndex);
  }, []);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setPageWidth(event.nativeEvent.layout.width);
  }, []);

  // Swipe: derive the settled page from the momentum-scroll offset and reconcile
  // analytics + the page control. Only fires on the slide path (Reduce Motion
  // locks scrolling, so the Next button drives transitions there).
  const handleMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (pageWidth <= 0) return;
      const nextIndex = Math.round(event.nativeEvent.contentOffset.x / pageWidth);
      goToIndex(nextIndex, 'swipe');
    },
    [pageWidth, goToIndex],
  );

  const handleNext = useCallback(() => {
    const fromIndex = activeIndexRef.current;
    if (fromIndex >= LAST_INDEX) {
      const durationSeconds = Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000));
      trackTourCompleted(durationSeconds);
      hapticSelection();
      onFinish();
      return;
    }
    const nextIndex = fromIndex + 1;
    // Reduce Motion: cross-fade (no animated slide). Otherwise slide.
    listRef.current?.scrollToIndex({ index: nextIndex, animated: !reduceMotion });
    goToIndex(nextIndex, 'next');
  }, [reduceMotion, goToIndex, onFinish]);

  const handleSkip = useCallback(() => {
    const index = activeIndexRef.current;
    trackTourSkipped(ONBOARDING_CARDS[index], index);
    onDone();
  }, [onDone]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<OnboardingCardData>) => (
      <OnboardingCard
        icon={item.icon}
        title={copy[item.id].title}
        body={copy[item.id].body}
        width={pageWidth}
        iconColor={iconColor}
        bodyColor={bodyColor}
      />
    ),
    [copy, pageWidth, iconColor, bodyColor],
  );

  // Stable per-page geometry so FlatList can scrollToIndex without measuring.
  const getItemLayout = useCallback(
    (_: ArrayLike<OnboardingCardData> | null | undefined, index: number) => ({
      length: pageWidth,
      offset: pageWidth * index,
      index,
    }),
    [pageWidth],
  );

  const isLast = activeIndex === LAST_INDEX;
  const footerPadding = useMemo(() => Math.max(insets.bottom, spacing[4]), [insets.bottom]);

  return (
    <View
      style={[styles.root, { backgroundColor, paddingTop: insets.top }]}
      onLayout={handleLayout}
      accessibilityViewIsModal
    >
      {pageWidth > 0 ? (
        <FlatList
          ref={listRef}
          data={ONBOARDING_CARDS}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          getItemLayout={getItemLayout}
          horizontal
          pagingEnabled
          // Reduce Motion: lock the swipe so transitions only happen via the
          // Next button's non-animated scrollToIndex (a cross-fade-style jump).
          scrollEnabled={!reduceMotion}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleMomentumEnd}
          bounces={false}
          style={styles.list}
        />
      ) : (
        <View style={styles.list} />
      )}

      <View style={styles.pageControl}>
        <OnboardingPageControl activeIndex={activeIndex} activeColor={accentColor} inactiveColor={inactiveDotColor} />
      </View>

      <GlassSurface
        glassEffectStyle="regular"
        // On the Material / Android / Reduce-Transparency paths GlassSurface
        // renders an opaque tonal surface; on iOS 26 the floating footer sits on
        // real Liquid Glass while the reading area above stays opaque.
        style={[styles.footer, { paddingBottom: footerPadding }]}
      >
        <View style={styles.footerInner}>
          <View style={styles.footerSlot}>
            {isLast ? null : (
              <Button
                title={t('mobile.onboarding.skip')}
                onPress={handleSkip}
                variant="text"
                size="large"
                haptic={false}
              />
            )}
          </View>
          <View style={styles.footerSlot}>
            <Button
              title={isLast ? t('mobile.onboarding.getStarted') : t('mobile.onboarding.next')}
              onPress={handleNext}
              variant="filled"
              size="large"
              tintColor={variant === 'material' ? undefined : accentColor}
              haptic={false}
              style={styles.cta}
            />
          </View>
        </View>
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  pageControl: {
    paddingVertical: spacing[4],
  },
  footer: {
    paddingTop: spacing[3],
    paddingHorizontal: spacing[5],
  },
  footerInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
  },
  footerSlot: {
    flex: 1,
  },
  cta: {
    alignSelf: 'flex-end',
  },
});
