import { StyleSheet } from 'react-native';
import type { TypographyScale } from '../../hooks/use-typography-styles';
import { borderRadius, spacing } from '../../theme/tokens';
import { CLIMB_ROW_GUTTER } from '../climb-list-row-styles';
export const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    container: {
      flex: 1,
      minHeight: 0,
    },
    headerBar: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 1,
      overflow: 'hidden',
    },
    headerBarRow: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      // Keep the centered name clear of the header's back / action buttons.
      paddingHorizontal: 64,
    },
    headerBarTitle: {
      fontWeight: '600',
    },
    hero: {
      marginBottom: spacing[2],
    },
    heroBanner: {
      borderBottomLeftRadius: borderRadius.xl,
      borderBottomRightRadius: borderRadius.xl,
      overflow: 'hidden',
      paddingBottom: spacing[5],
    },
    heroBannerContent: {
      paddingHorizontal: spacing[4],
    },
    heroEmoji: {
      fontSize: textStyles.largeTitle.fontSize,
      lineHeight: textStyles.largeTitle.lineHeight,
      marginBottom: spacing[2],
    },
    heroName: {
      textShadowColor: 'rgba(0, 0, 0, 0.35)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 3,
    },
    heroNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[2],
    },
    heroNameFlex: {
      flexShrink: 1,
    },
    heroCog: {
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    heroBannerMeta: {
      marginTop: 2,
      opacity: 0.85,
    },
    heroBelow: {
      paddingHorizontal: spacing[4],
      paddingTop: spacing[4],
      paddingBottom: spacing[5],
      gap: 2,
    },
    heroSubtitle: {
      opacity: 0.5,
    },
    heroDescription: {
      opacity: 0.7,
    },
    // ── Material hero ──────────────────────────────────────────────────────────
    materialAppbarContainer: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 2,
    },
    // Wraps Appbar.Content so the title can fade in (opacity-animated) as the hero
    // band scrolls under the bar, without animating the back / play actions.
    materialAppbarTitle: {
      flex: 1,
    },
    materialAppbarTitleText: {
      fontSize: textStyles.body.fontSize,
      fontWeight: '600',
    },
    materialHero: {
      marginBottom: spacing[2],
    },
    materialHeroBand: {
      alignItems: 'center',
      paddingHorizontal: spacing[5],
      paddingBottom: spacing[6],
      borderBottomLeftRadius: borderRadius.xl,
      borderBottomRightRadius: borderRadius.xl,
    },
    materialHeroEmojiCircle: {
      width: 72,
      height: 72,
      borderRadius: 36,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing[3],
    },
    materialHeroEmoji: {
      fontSize: textStyles.largeTitle.fontSize,
      lineHeight: textStyles.largeTitle.lineHeight,
    },
    materialHeroNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing[2],
    },
    materialHeroName: {
      textAlign: 'center',
      flexShrink: 1,
    },
    materialHeroMeta: {
      marginTop: 2,
      textAlign: 'center',
    },
    materialEmptyTitle: {
      textAlign: 'center',
    },
    materialEmptySupporting: {
      textAlign: 'center',
    },
    emptyActionButton: {
      marginTop: spacing[4],
    },
    banner: {
      marginHorizontal: spacing[4],
      marginTop: spacing[2],
      marginBottom: spacing[2],
      padding: spacing[4],
      borderRadius: borderRadius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      gap: spacing[3],
    },
    bannerRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing[3],
    },
    bannerText: {
      flex: 1,
      gap: 2,
    },
    bannerTitle: {
      fontWeight: '600',
      marginBottom: 2,
    },
    bannerButton: {
      alignSelf: 'flex-start',
    },
    footer: {
      paddingVertical: 20,
      alignItems: 'center',
    },
    skeletonList: {
      paddingTop: spacing[2],
    },
    stateContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 80,
      paddingHorizontal: 32,
      gap: 12,
    },
    emptyText: {
      opacity: 0.5,
      textAlign: 'center',
    },
    unrenderableOuter: {
      position: 'relative',
      overflow: 'hidden',
    },
    unrenderableRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: CLIMB_ROW_GUTTER,
      paddingVertical: spacing[2],
      gap: spacing[2],
    },
    unrenderableContent: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing[3],
    },
    // Sized at the call site from `useClimbListThumbnailSize`.
    unrenderableThumbnail: {
      borderRadius: borderRadius.md,
      borderWidth: StyleSheet.hairlineWidth,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    unrenderableText: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    unrenderableTitle: {
      fontWeight: '600',
    },
    unrenderableRemove: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    unrenderablePressed: {
      opacity: 0.6,
    },
    unrenderableSeparator: {
      height: StyleSheet.hairlineWidth,
    },
  });
