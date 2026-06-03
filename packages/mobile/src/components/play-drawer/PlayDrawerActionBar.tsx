import { memo, useCallback } from 'react';
import { View, Pressable, Platform, StyleSheet, type ViewStyle } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { BleLightbulbButton } from '../ble/BleLightbulbButton';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, shadows } from '../../theme/tokens';
import { hapticMedium } from '../../lib/haptics';

type ButtonSize = 'lg' | 'sm';

const SIZES: Record<ButtonSize, { dim: number; icon: number }> = {
  lg: { dim: 56, icon: 28 },
  sm: { dim: 40, icon: 22 },
};

type PlayDrawerActionBarProps = {
  canSwipePrevious: boolean;
  canSwipeNext: boolean;
  isMirrored: boolean;
  supportsMirroring: boolean;
  isFavorited: boolean;
  remainingQueueCount: number;
  lightbulbActive: boolean;
  lightbulbPending?: boolean;
  ascentCount: number;
  currentAngle?: number;
  onPrevClick: () => void;
  onNextClick: () => void;
  onMirror: () => void;
  onToggleFavorite: () => void;
  onLightbulb: () => void;
  onOpenActions: () => void;
  onOpenQueue: () => void;
  onShare: () => void;
  onTickPress: () => void;
  onTickLongPress: () => void;
  onOpenAngleSelector?: () => void;
};

export const PlayDrawerActionBar = memo(function PlayDrawerActionBar({
  canSwipePrevious,
  canSwipeNext,
  isMirrored,
  supportsMirroring,
  isFavorited,
  remainingQueueCount,
  lightbulbActive,
  lightbulbPending = false,
  ascentCount,
  currentAngle,
  onPrevClick,
  onNextClick,
  onMirror,
  onToggleFavorite,
  onLightbulb,
  onOpenActions,
  onOpenQueue,
  onShare,
  onTickPress,
  onTickLongPress,
  onOpenAngleSelector,
}: PlayDrawerActionBarProps) {
  const { t } = useTranslation('session');
  const { t: tClimbs } = useTranslation('climbs');
  const { t: tSettings } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');

  const handlePrev = useCallback(() => {
    hapticMedium();
    onPrevClick();
  }, [onPrevClick]);

  const handleNext = useCallback(() => {
    hapticMedium();
    onNextClick();
  }, [onNextClick]);

  const handleMirror = useCallback(() => {
    hapticMedium();
    onMirror();
  }, [onMirror]);

  const handleFavorite = useCallback(() => {
    hapticMedium();
    onToggleFavorite();
  }, [onToggleFavorite]);

  const handleAngleSelector = useCallback(() => {
    hapticMedium();
    onOpenAngleSelector?.();
  }, [onOpenAngleSelector]);

  const handleShare = useCallback(() => {
    hapticMedium();
    onShare();
  }, [onShare]);

  return (
    <View style={styles.container}>
      <View style={styles.rowPrimary}>
        <View style={styles.primarySlot}>
          {supportsMirroring ? (
            <ActionButton
              size="lg"
              iconName="mirror"
              onPress={handleMirror}
              active={isMirrored}
              activeColor={brandColors.primary}
              accessibilityLabel={
                isMirrored ? t('playView.actionBar.unmirrorAria') : t('playView.actionBar.mirrorAria')
              }
            />
          ) : (
            // On boards without mirror support, the favorite (heart) takes the
            // first slot — keeps the row visually balanced and gives heart a
            // bigger tap target. It is removed from Row 2 below in that case.
            <ActionButton
              size="lg"
              iconName={isFavorited ? 'favorite.fill' : 'favorite'}
              onPress={handleFavorite}
              iconColor={isFavorited ? iosSystemColors.systemRed : undefined}
              accessibilityLabel={
                isFavorited ? t('playView.actionBar.removeFavoriteAria') : t('playView.actionBar.addFavoriteAria')
              }
            />
          )}
        </View>
        <View style={styles.primarySlot}>
          <ActionButton
            size="lg"
            iconName="skip.previous"
            onPress={handlePrev}
            disabled={!canSwipePrevious}
            accessibilityLabel={t('playView.actionBar.previousAria')}
          />
        </View>
        <View style={styles.primarySlot}>
          <TickButton
            size="lg"
            ascentCount={ascentCount}
            onPress={onTickPress}
            onLongPress={onTickLongPress}
            accessibilityLabel={t('playView.tickFab.logAscentAria')}
          />
        </View>
        <View style={styles.primarySlot}>
          <ActionButton
            size="lg"
            iconName="skip.next"
            onPress={handleNext}
            disabled={!canSwipeNext}
            accessibilityLabel={t('playView.actionBar.nextAria')}
          />
        </View>
        <View style={styles.primarySlot}>
          <BleLightbulbButton
            isConnected={lightbulbActive}
            isScanning={lightbulbPending}
            onPress={onLightbulb}
            accessibilityLabel={lightbulbActive ? tCommon('lightControl.disconnect') : tSettings('ble.connectBoard')}
            scanningAccessibilityHint={tSettings('ble.scanning')}
            haptic="medium"
            size={SIZES.lg.icon}
            containerSize={SIZES.lg.dim}
          />
        </View>
      </View>

      <View style={styles.rowSecondary}>
        {onOpenAngleSelector && currentAngle != null && (
          <Pressable
            onPress={handleAngleSelector}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.angleSelector.title')}
            style={({ pressed }) => [
              styles.anglePill,
              { height: SIZES.sm.dim, borderRadius: SIZES.sm.dim / 2 },
              pressed && styles.actionButtonPressed,
            ]}
          >
            <Text variant="caption1" style={styles.angleText}>
              {currentAngle}°
            </Text>
          </Pressable>
        )}
        {supportsMirroring && (
          <ActionButton
            size="sm"
            iconName={isFavorited ? 'favorite.fill' : 'favorite'}
            onPress={handleFavorite}
            iconColor={isFavorited ? iosSystemColors.systemRed : undefined}
            accessibilityLabel={
              isFavorited ? t('playView.actionBar.removeFavoriteAria') : t('playView.actionBar.addFavoriteAria')
            }
          />
        )}
        <ActionButton
          size="sm"
          iconName="more"
          onPress={onOpenActions}
          accessibilityLabel={t('playView.actionBar.climbActionsAria')}
        />

        <View style={styles.spacer} />

        <ShareButton size="sm" onPress={handleShare} accessibilityLabel={tClimbs('mobile.climbRow.share')} />
        <ActionButton
          size="sm"
          iconName="queue"
          onPress={onOpenQueue}
          accessibilityLabel={t('playView.actionBar.queueCountAria', { count: remainingQueueCount })}
        />
      </View>
    </View>
  );
});

type ActionButtonProps = {
  iconName: import('../icon-map').IconName;
  size: ButtonSize;
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
  activeColor?: string;
  iconColor?: string;
  accessibilityLabel: string;
};

function ActionButton({
  iconName,
  size,
  onPress,
  disabled = false,
  active = false,
  activeColor,
  iconColor,
  accessibilityLabel,
}: ActionButtonProps) {
  const { dim, icon } = SIZES[size];
  const buttonStyle: ViewStyle[] = [styles.actionButton, { width: dim, height: dim, borderRadius: dim / 2 }];
  if (active && activeColor) {
    buttonStyle.push({ backgroundColor: `${activeColor}20` });
  }

  const resolvedColor = disabled
    ? iosSystemColors.systemGray4
    : (iconColor ?? (active && activeColor ? activeColor : iosSystemColors.systemGray));

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        ...buttonStyle,
        disabled && styles.actionButtonDisabled,
        pressed && !disabled && styles.actionButtonPressed,
      ]}
    >
      <Icon name={iconName} size={icon} color={resolvedColor} />
    </Pressable>
  );
}

type ShareButtonProps = {
  size: ButtonSize;
  onPress: () => void;
  accessibilityLabel: string;
};

// Renders the native iOS share glyph (square.and.arrow.up) on iOS via expo-symbols.
// Falls back to the Material Design share icon on Android (via the standard Icon
// component, which uses MaterialCommunityIcons).
function ShareButton({ size, onPress, accessibilityLabel }: ShareButtonProps) {
  const { dim, icon } = SIZES[size];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.actionButton,
        { width: dim, height: dim, borderRadius: dim / 2 },
        pressed && styles.actionButtonPressed,
      ]}
    >
      {Platform.OS === 'ios' ? (
        <SymbolView name="square.and.arrow.up" size={icon} tintColor={iosSystemColors.systemGray} />
      ) : (
        <Icon name="share" size={icon} color={iosSystemColors.systemGray} />
      )}
    </Pressable>
  );
}

type TickButtonProps = {
  size: ButtonSize;
  ascentCount: number;
  onPress: () => void;
  onLongPress?: () => void;
  accessibilityLabel: string;
};

function TickButton({ size, ascentCount, onPress, onLongPress, accessibilityLabel }: TickButtonProps) {
  const { dim, icon } = SIZES[size];
  const handlePress = useCallback(() => {
    hapticMedium();
    onPress();
  }, [onPress]);
  const handleLongPress = useCallback(() => {
    if (!onLongPress) return;
    hapticMedium();
    onLongPress();
  }, [onLongPress]);

  return (
    <Pressable
      onPress={handlePress}
      onLongPress={handleLongPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.tickButton,
        { width: dim, height: dim, borderRadius: dim / 2 },
        pressed && styles.tickButtonPressed,
      ]}
    >
      <Icon name="tick.outline" size={icon} color={iosSystemColors.white} />
      {ascentCount > 0 && (
        <View style={styles.countBadge}>
          <Text variant="caption2" color={iosSystemColors.white} style={styles.countText}>
            {ascentCount > 99 ? '99' : String(ascentCount)}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: iosSystemColors.separator,
  },
  rowPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
  },
  primarySlot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[3],
  },
  spacer: {
    flex: 1,
  },
  actionButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButtonDisabled: {
    opacity: 0.4,
  },
  actionButtonPressed: {
    opacity: 0.6,
    transform: [{ scale: 0.9 }],
  },
  anglePill: {
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${iosSystemColors.systemGray}1F`,
  },
  angleText: {
    fontWeight: '600',
    color: iosSystemColors.systemGray,
  },
  tickButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: brandColors.success,
    ...shadows.md,
  },
  tickButtonPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.92 }],
  },
  countBadge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: brandColors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  countText: {
    fontSize: 10,
    fontWeight: '600',
    lineHeight: 12,
  },
});
