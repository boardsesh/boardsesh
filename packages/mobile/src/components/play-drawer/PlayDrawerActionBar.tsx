import { memo, useCallback } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { BleLightbulbButton } from '../ble/BleLightbulbButton';
import { LightbulbHolderBadge } from './LightbulbHolderBadge';
import { ActionButton, SIZES, type ButtonSize, drawerActionBarStyles } from '../drawer-action-bar/DrawerActionBar';
import { useTheme } from '../../providers/theme-provider';
// Aliased: foregrounds in this file read scheme-aware brand from `useTheme()`.
// `staticBrandColors` is the static set, used only for the count badge — a FILL
// with white text that must stay legible in both schemes.
import { brandColors as staticBrandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { glassSize } from '../../theme/layout';
import { hapticMedium } from '../../lib/haptics';

type PlayDrawerActionBarProps = {
  canSwipePrevious: boolean;
  canSwipeNext: boolean;
  isMirrored: boolean;
  supportsMirroring: boolean;
  isFavorited: boolean;
  remainingQueueCount: number;
  /** Filled/lit visual — OR'd in the parent (this device's BLE, a board-presence
   *  holder, or the session wall-lit signal). Visual only. */
  lightbulbActive: boolean;
  /** Whether THIS device's BLE link is connected. Drives the tap action's
   *  meaning, so it also drives the accessibility label + selected state:
   *  connected → tapping disconnects ("turn off"); not connected → tapping
   *  connects ("connect board"). Distinct from `lightbulbActive`, which a peer
   *  can light. */
  lightbulbConnected: boolean;
  lightbulbPending?: boolean;
  lightbulbAccessibilityLabel?: string;
  lightbulbLongPressAccessibilityHint?: string;
  lightbulbLongPressEnabled?: boolean;
  /** Show the holder avatar pip on the lightbulb. Suppressed when the on-wall
   *  banner already carries the driver's face in the header, so the same face
   *  never appears twice in the drawer. */
  showHolderBadge?: boolean;
  ascentCount: number;
  currentAngle?: number;
  onPrevClick: () => void;
  onNextClick: () => void;
  onMirror: () => void;
  onToggleFavorite: () => void;
  onLightbulb: () => void;
  onLightbulbLongPress?: () => void;
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
  lightbulbConnected,
  lightbulbPending = false,
  lightbulbAccessibilityLabel,
  lightbulbLongPressAccessibilityHint,
  lightbulbLongPressEnabled = lightbulbActive,
  showHolderBadge = true,
  ascentCount,
  currentAngle,
  onPrevClick,
  onNextClick,
  onMirror,
  onToggleFavorite,
  onLightbulb,
  onLightbulbLongPress,
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
  const theme = useTheme();

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
    <View style={drawerActionBarStyles.container}>
      <View style={drawerActionBarStyles.rowPrimary}>
        <View style={drawerActionBarStyles.primarySlot}>
          {supportsMirroring ? (
            <ActionButton
              size="lg"
              iconName="mirror"
              onPress={handleMirror}
              active={isMirrored}
              activeColor={theme.brandColors.primary}
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
        <View style={drawerActionBarStyles.primarySlot}>
          <ActionButton
            size="lg"
            iconName="skip.previous"
            onPress={handlePrev}
            disabled={!canSwipePrevious}
            accessibilityLabel={t('playView.actionBar.previousAria')}
          />
        </View>
        <View style={drawerActionBarStyles.primarySlot}>
          <TickButton
            size="lg"
            ascentCount={ascentCount}
            onPress={onTickPress}
            onLongPress={onTickLongPress}
            accessibilityLabel={t('playView.tickFab.logAscentAria')}
          />
        </View>
        <View style={drawerActionBarStyles.primarySlot}>
          <ActionButton
            size="lg"
            iconName="skip.next"
            onPress={handleNext}
            disabled={!canSwipeNext}
            accessibilityLabel={t('playView.actionBar.nextAria')}
          />
        </View>
        <View style={drawerActionBarStyles.primarySlot}>
          <BleLightbulbButton
            isConnected={lightbulbActive}
            accessibilitySelected={lightbulbConnected}
            isScanning={lightbulbPending}
            onPress={onLightbulb}
            onLongPress={lightbulbLongPressEnabled ? onLightbulbLongPress : undefined}
            accessibilityLabel={
              lightbulbAccessibilityLabel ??
              (lightbulbConnected ? tSettings('ble.turnOff') : tSettings('ble.connectBoard'))
            }
            scanningAccessibilityHint={tSettings('ble.scanning')}
            longPressAccessibilityHint={
              lightbulbLongPressEnabled
                ? (lightbulbLongPressAccessibilityHint ?? tSettings('ble.holdForControls'))
                : undefined
            }
            haptic="medium"
            size={SIZES.lg.icon}
            containerSize={SIZES.lg.dim}
          />
          {/* "Who's connected" pip — the board-presence holder's avatar overlaid
              on the lightbulb's top-right. Self-reads board presence and renders
              nothing when the wall is free, so it never disturbs the slot's layout.
              Suppressed when the on-wall banner already shows the driver in the
              header, so the same face never appears twice in the drawer. */}
          {showHolderBadge ? (
            <View style={styles.connectionBadge} pointerEvents="none">
              <LightbulbHolderBadge size={18} />
            </View>
          ) : null}
        </View>
      </View>

      <View style={drawerActionBarStyles.rowSecondary}>
        {onOpenAngleSelector && currentAngle != null && (
          <Pressable
            onPress={handleAngleSelector}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.angleSelector.title')}
            // A label-only mini pill (32pt); hit-slop lifts the tap target back to
            // the 44pt floor without growing the visual chip.
            hitSlop={8}
            style={({ pressed }) => [styles.anglePill, pressed && drawerActionBarStyles.actionButtonPressed]}
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

        <View style={drawerActionBarStyles.spacer} />

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

type ShareButtonProps = {
  size: ButtonSize;
  onPress: () => void;
  accessibilityLabel: string;
};

// The share glyph resolves to the native iOS share symbol (square.and.arrow.up) on
// iOS and the Material Design share icon on Android — Icon picks per platform from
// the shared icon-map.
function ShareButton({ size, onPress, accessibilityLabel }: ShareButtonProps) {
  const { dim, icon } = SIZES[size];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        drawerActionBarStyles.actionButton,
        { width: dim, height: dim, borderRadius: dim / 2 },
        pressed && drawerActionBarStyles.actionButtonPressed,
      ]}
    >
      <Icon name="share" size={icon} color={iosSystemColors.systemGray} />
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
  const theme = useTheme();
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
        drawerActionBarStyles.actionButton,
        { width: dim, height: dim, borderRadius: dim / 2 },
        pressed && drawerActionBarStyles.actionButtonPressed,
      ]}
    >
      {/* The primary log action: a green glyph on the glass sheet (colour on the
          icon, not a fill) — its hue and the count badge mark it as the hero. */}
      <Icon name="tick.outline" size={icon} color={theme.brandColors.success} />
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
  // Holder avatar overlaid on the lightbulb's top-right corner.
  connectionBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
  },
  // A neutral, label-only outlined capsule (no colour fill) — the mini inline tier.
  anglePill: {
    height: glassSize.mini,
    borderRadius: glassSize.mini / 2,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: iosSystemColors.separator,
  },
  angleText: {
    fontWeight: '600',
    color: iosSystemColors.systemGray,
  },
  countBadge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    // FILL with white count text → static brand (see import note).
    backgroundColor: staticBrandColors.primary,
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
