import { memo, useCallback } from 'react';
import { View, Pressable, StyleSheet, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { ActionBarContract } from '@boardsesh/play-view';
import { Icon } from '../Icon';
import { Badge } from '../Badge';
import { Text } from '../Text';
import { BleLightbulbButton } from '../ble/BleLightbulbButton';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';
import { hapticMedium } from '../../lib/haptics';

type PlayDrawerActionBarProps = ActionBarContract & {
  currentAngle?: number;
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
  onPrevClick,
  onNextClick,
  onMirror,
  onToggleFavorite,
  onLightbulb,
  onOpenActions,
  onOpenQueue,
  currentAngle,
  onOpenAngleSelector,
}: PlayDrawerActionBarProps) {
  const { t } = useTranslation('session');
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

  return (
    <View style={styles.container}>
      {/* Previous */}
      <ActionButton
        iconName="skip.previous"
        onPress={handlePrev}
        disabled={!canSwipePrevious}
        accessibilityLabel={t('playView.actionBar.previousAria')}
      />

      {/* Mirror */}
      {supportsMirroring && (
        <ActionButton
          iconName="mirror"
          onPress={handleMirror}
          active={isMirrored}
          activeColor={brandColors.primary}
          accessibilityLabel={isMirrored ? t('playView.actionBar.unmirrorAria') : t('playView.actionBar.mirrorAria')}
        />
      )}

      {/* Favorite */}
      <ActionButton
        iconName={isFavorited ? 'favorite.fill' : 'favorite'}
        onPress={handleFavorite}
        iconColor={isFavorited ? iosSystemColors.systemRed : undefined}
        accessibilityLabel={
          isFavorited ? t('playView.actionBar.removeFavoriteAria') : t('playView.actionBar.addFavoriteAria')
        }
      />

      {/* Lightbulb */}
      <BleLightbulbButton
        isConnected={lightbulbActive}
        isScanning={lightbulbPending}
        onPress={onLightbulb}
        accessibilityLabel={lightbulbActive ? tCommon('lightControl.disconnect') : tSettings('ble.connectBoard')}
      />

      {/* Angle pill */}
      {onOpenAngleSelector && currentAngle != null && (
        <Pressable
          onPress={handleAngleSelector}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.angleSelector.title')}
          style={({ pressed }) => [styles.actionButton, styles.anglePill, pressed && styles.actionButtonPressed]}
        >
          <Text variant="caption1" style={styles.angleText}>
            {currentAngle}°
          </Text>
        </Pressable>
      )}

      {/* More actions */}
      <ActionButton
        iconName="more"
        onPress={onOpenActions}
        accessibilityLabel={t('playView.actionBar.climbActionsAria')}
      />

      {/* Queue */}
      <View>
        <ActionButton
          iconName="queue"
          onPress={onOpenQueue}
          accessibilityLabel={t('playView.actionBar.queueCountAria', { count: remainingQueueCount })}
        />
        {remainingQueueCount > 0 && (
          <View style={styles.badgeContainer}>
            <Badge count={remainingQueueCount} color={brandColors.primary} size="small" />
          </View>
        )}
      </View>

      {/* Next */}
      <ActionButton
        iconName="skip.next"
        onPress={handleNext}
        disabled={!canSwipeNext}
        accessibilityLabel={t('playView.actionBar.nextAria')}
      />
    </View>
  );
});

type ActionButtonProps = {
  iconName: import('../icon-map').IconName;
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
  activeColor?: string;
  iconColor?: string;
  accessibilityLabel: string;
};

function ActionButton({
  iconName,
  onPress,
  disabled = false,
  active = false,
  activeColor,
  iconColor,
  accessibilityLabel,
}: ActionButtonProps) {
  const buttonStyle: ViewStyle[] = [styles.actionButton];
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
      <Icon name={iconName} size={24} color={resolvedColor} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: iosSystemColors.separator,
  },
  actionButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  actionButtonDisabled: {
    opacity: 0.4,
  },
  actionButtonPressed: {
    opacity: 0.6,
    transform: [{ scale: 0.9 }],
  },
  badgeContainer: {
    position: 'absolute',
    top: 2,
    right: 2,
  },
  anglePill: {
    paddingHorizontal: 10,
    backgroundColor: `${iosSystemColors.systemGray}1F`,
  },
  angleText: {
    fontWeight: '600',
    color: iosSystemColors.systemGray,
  },
});
