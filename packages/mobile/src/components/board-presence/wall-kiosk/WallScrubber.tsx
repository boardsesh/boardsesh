import { memo, useCallback } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../../Text';
import { Icon } from '../../Icon';
import { ActionButton } from '../../drawer-action-bar/DrawerActionBar';
import { useOptionalBluetoothContext } from '../../../providers/bluetooth-provider';
import { useTheme } from '../../../providers/theme-provider';
import { hapticSelection } from '../../../lib/haptics';
import { borderRadius, spacing } from '../../../theme/tokens';
import type { WallPreviewState } from './useWallPreview';

type WallScrubberProps = {
  preview: WallPreviewState;
};

/**
 * The preview-then-confirm control stack (a vertical cluster the chrome region
 * places in the rail's bottom or the band's control column): step older/newer /
 * oldest / live through the wall's history, the violet "Light this climb" confirm
 * that re-lights the physical wall, and a labeled "Back to live". No readout (the
 * state strip owns it) and no over-board floating variant.
 */
function WallScrubberComponent({ preview }: WallScrubberProps) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const bluetooth = useOptionalBluetoothContext();
  // Optional-field contract: only an explicit `hasLeds: false` reaches the
  // context as `ledless`, so a missing/stale flag keeps every Bluetooth
  // affordance exactly as it is today.
  const ledless = bluetooth?.ledless ?? false;
  const takeVirtualWall = bluetooth?.takeVirtualWall;

  const {
    isPreviewing,
    canStepOlder,
    canStepNewer,
    isLoadingOlder,
    stepsBack,
    historyCount,
    previewClimb,
    step,
    goOldest,
    backToLive,
    canLight,
    lightBlockedReason,
    isLighting,
    lightError,
    lightThis,
    pendingOverride,
    confirmOverride,
    cancelOverride,
    liveClimb,
  } = preview;

  const previewName = previewClimb?.name ?? '';

  const withHaptic = useCallback(
    (fn: () => void) => () => {
      hapticSelection();
      fn();
    },
    [],
  );

  // Deliberately NOT wrapped in `withHaptic`: taking the wall is a state change,
  // not a selection, and `takeVirtualWall` fires its own hapticLight alongside
  // the "You've got the wall" toast. Wrapping it would buzz twice.
  const handleTakeWall = useCallback(() => {
    takeVirtualWall?.();
  }, [takeVirtualWall]);

  // Live/idle: only backward navigation is meaningful (nothing is newer than the
  // live wall), so show a single labeled "Browse history" affordance — not a row of
  // four transport icons where ⏮/‹ read as duplicate "previous" and ›/⏭ as
  // duplicate "next" with a disabled "next" implying a newer climb exists.
  // Previewing: a proper bidirectional scrubber (oldest · older · newer); the
  // labeled "Back to live" below replaces the skip-to-live icon.
  const navRow = isPreviewing ? (
    <View style={styles.navGroup}>
      {historyCount > 0 ? (
        <Text variant="caption2" color={systemColors.secondaryLabel} style={styles.rangeReadout}>
          {t('mobile.boardPresence.kiosk.rangeLabel', { count: stepsBack, total: historyCount })}
        </Text>
      ) : null}
      <View style={styles.navRow}>
        <View style={styles.navButton}>
          <ActionButton
            iconName="skip.previous"
            size="sm"
            onPress={withHaptic(goOldest)}
            disabled={!canStepOlder}
            accessibilityLabel={t('mobile.boardPresence.kiosk.scrubOldestAria')}
          />
          <Text
            variant="caption2"
            color={systemColors.secondaryLabel}
            style={[styles.navLabel, !canStepOlder && styles.labelDim]}
          >
            {t('mobile.boardPresence.kiosk.scrubOldestLabel')}
          </Text>
        </View>
        <View style={styles.navButton}>
          <ActionButton
            iconName="chevron.left"
            size="lg"
            onPress={withHaptic(() => step('older'))}
            disabled={!canStepOlder}
            accessibilityLabel={t('mobile.boardPresence.kiosk.scrubOlderAria')}
          />
          <Text
            variant="caption2"
            color={systemColors.secondaryLabel}
            style={[styles.navLabel, !canStepOlder && styles.labelDim]}
          >
            {t('mobile.boardPresence.kiosk.scrubOlderLabel')}
          </Text>
        </View>
        <View style={styles.navButton}>
          <ActionButton
            iconName="chevron.right"
            size="lg"
            onPress={withHaptic(() => step('newer'))}
            disabled={!canStepNewer}
            accessibilityLabel={t('mobile.boardPresence.kiosk.scrubNewerAria')}
          />
          <Text
            variant="caption2"
            color={systemColors.secondaryLabel}
            style={[styles.navLabel, !canStepNewer && styles.labelDim]}
          >
            {t('mobile.boardPresence.kiosk.scrubNewerLabel')}
          </Text>
        </View>
        {isLoadingOlder ? <ActivityIndicator size="small" color={systemColors.secondaryLabel} /> : null}
      </View>
    </View>
  ) : (
    <Pressable
      onPress={withHaptic(() => step('older'))}
      disabled={!canStepOlder}
      accessibilityLabel={t('mobile.boardPresence.kiosk.scrubOlderAria')}
      style={({ pressed }) => [
        styles.browseHistory,
        { borderColor: systemColors.separator },
        pressed && styles.pressed,
        !canStepOlder && styles.disabled,
      ]}
    >
      <Icon name="chevron.left" size={22} color={systemColors.label} />
      <Text variant="callout" color={systemColors.label} style={styles.bold}>
        {t('mobile.boardPresence.kiosk.browseHistory')}
      </Text>
    </Pressable>
  );

  // On a wall with no lights nothing is lit — the climb goes UP on the wall, so
  // the confirm reads "Put <name> up" / "Putting it up…" instead of "Light this".
  const relightLabel = ledless
    ? t('mobile.boardPresence.kiosk.putUpThis', { name: previewName })
    : t('mobile.boardPresence.kiosk.lightThis', { name: previewName });
  const inFlightLabel = ledless ? t('mobile.boardPresence.kiosk.puttingUp') : t('mobile.boardPresence.kiosk.lighting');

  const confirmSlot = !isPreviewing ? null : pendingOverride ? (
    <View style={styles.overrideBox}>
      <Text variant="footnote" color={systemColors.label} style={styles.overrideBody}>
        {t('mobile.boardPresence.kiosk.confirmOverrideBody', { name: liveClimb?.name ?? '' })}
      </Text>
      <View style={styles.overrideActions}>
        <Pressable
          onPress={withHaptic(cancelOverride)}
          style={[styles.secondaryBtn, { borderColor: systemColors.separator }]}
        >
          <Text variant="footnote" color={systemColors.label}>
            {t('mobile.boardPresence.kiosk.confirmOverrideCancel')}
          </Text>
        </Pressable>
        <Pressable
          onPress={withHaptic(confirmOverride)}
          style={[styles.primaryBtn, { backgroundColor: brandColors.primaryFill }]}
        >
          <Text variant="footnote" color={brandColors.onPrimary} style={styles.bold}>
            {t('mobile.boardPresence.kiosk.confirmOverrideConfirm')}
          </Text>
        </Pressable>
      </View>
    </View>
  ) : lightBlockedReason === 'not-driver' ? (
    <Pressable
      onPress={withHaptic(() => void bluetooth?.connect())}
      disabled={!bluetooth}
      style={({ pressed }) => [
        styles.filledButton,
        { backgroundColor: systemColors.fill },
        pressed && styles.pressed,
        !bluetooth && styles.disabled,
      ]}
    >
      <Icon name="bluetooth" size={20} color={systemColors.label} />
      <Text
        variant="callout"
        color={systemColors.label}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.75}
        style={styles.bold}
      >
        {t('mobile.boardPresence.kiosk.notDriverChip', { name: previewName })}
      </Text>
    </Pressable>
  ) : lightBlockedReason === 'no-leds-not-held' ? (
    // Wall with no light kit: there is no Bluetooth link to offer, so the way to
    // put a climb up is to take the wall. Session-local — nothing is written to
    // the board record here.
    <Pressable
      onPress={handleTakeWall}
      disabled={!takeVirtualWall}
      style={({ pressed }) => [
        styles.filledButton,
        { backgroundColor: systemColors.fill },
        pressed && styles.pressed,
        !takeVirtualWall && styles.disabled,
      ]}
    >
      <Icon name="pin" size={20} color={systemColors.label} />
      <Text
        variant="callout"
        color={systemColors.label}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.75}
        style={styles.bold}
      >
        {t('mobile.boardPresence.kiosk.noLedsNotHeldChip', { name: previewName })}
      </Text>
    </Pressable>
  ) : lightBlockedReason === 'no-frames' ? (
    <View style={styles.blockedChip}>
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {t('mobile.boardPresence.kiosk.noFrames')}
      </Text>
    </View>
  ) : (
    <Pressable
      onPress={withHaptic(lightThis)}
      disabled={!canLight}
      style={({ pressed }) => [
        styles.filledButton,
        { backgroundColor: brandColors.primaryFill },
        pressed && styles.pressed,
        !canLight && styles.disabled,
      ]}
    >
      {isLighting ? (
        <ActivityIndicator size="small" color={brandColors.onPrimary} />
      ) : (
        <Icon name="lightbulb.fill" size={20} color={brandColors.onPrimary} />
      )}
      <Text
        variant="callout"
        color={brandColors.onPrimary}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.75}
        style={styles.bold}
      >
        {isLighting ? inFlightLabel : lightError ? t('mobile.boardPresence.kiosk.lightFailed') : relightLabel}
      </Text>
    </Pressable>
  );

  return (
    <View style={styles.root}>
      {navRow}
      {confirmSlot}
      {isPreviewing ? (
        <Pressable onPress={withHaptic(backToLive)} style={styles.backToLive}>
          <Icon name="skip.next" size={16} color={brandColors.live} />
          <Text variant="footnote" color={brandColors.live} style={styles.bold}>
            {t('mobile.boardPresence.kiosk.backToLive')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export const WallScrubber = memo(WallScrubberComponent);

const styles = StyleSheet.create({
  root: { gap: spacing[3] },
  navGroup: {
    gap: spacing[2],
  },
  rangeReadout: {
    textAlign: 'center',
    fontWeight: '600',
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: spacing[3],
    minHeight: 56,
  },
  navButton: {
    alignItems: 'center',
    gap: spacing[1],
  },
  navLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    fontWeight: '600',
  },
  labelDim: {
    opacity: 0.35,
  },
  browseHistory: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    minHeight: 56,
    paddingHorizontal: spacing[4],
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  filledButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    borderRadius: borderRadius.full,
    minHeight: 56,
  },
  bold: { fontWeight: '700' },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.5 },
  backToLive: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    paddingVertical: spacing[2],
  },
  blockedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(128,128,128,0.4)',
    minHeight: 56,
  },
  overrideBox: {
    gap: spacing[2],
    padding: spacing[3],
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(128,128,128,0.4)',
  },
  overrideBody: { textAlign: 'center' },
  overrideActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing[2],
  },
  secondaryBtn: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
    // 8dp of padding around footnote text is ~34dp of touch target — under the
    // 44dp floor. Pin the height and centre the label inside it.
    minHeight: 44,
    justifyContent: 'center',
  },
  primaryBtn: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.full,
    minHeight: 44,
    justifyContent: 'center',
  },
});
