import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { MiniPlayerButtonId } from '../../lib/mini-player-buttons';
import { useTheme } from '../../providers/theme-provider';
import { opacity } from '../../theme/tokens';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { PressableSurface } from '../PressableSurface';
import { useSegments } from 'expo-router';
import { isPlayerRoute } from '../../lib/route-segments';
import { MiniPlayerTrackPager, useMiniPlayerNavigation } from './use-mini-player-navigation';

type MiniPlayerIconButtonProps = {
  iconName: IconName;
  accessibilityLabel: string;
  onPress: () => void;
  disabled: boolean;
  size: number;
};

/** A borderless platter control, drawn like the tick beside it: UIKit supplies the glass. */
function MiniPlayerIconButton({ iconName, accessibilityLabel, onPress, disabled, size }: MiniPlayerIconButtonProps) {
  const { systemColors } = useTheme();
  return (
    <PressableSurface
      onPress={onPress}
      disabled={disabled}
      feedback="opacity"
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      style={[styles.action, { width: size, height: size }, disabled ? styles.disabled : null]}
    >
      <Icon maxFontSizeMultiplier={1} name={iconName} size={22} color={systemColors.label} />
    </PressableSurface>
  );
}

const TRANSPORT: ReadonlySet<MiniPlayerButtonId> = new Set(['previous', 'next']);

type MiniPlayerLeadingButtonsProps = {
  /** Left to right, as `resolveMiniPlayerControls` placed them. */
  buttonIds: readonly MiniPlayerButtonId[];
  slotWidth: number;
  rowHeight: number;
  /** The space between the climber's other buttons and ⏮ ⏭. Zero on an iPhone, where every point goes to the name. */
  groupGap: number;
};

/**
 * The MiniPlayer's buttons before Board light and Log (#6940). Each sits in a
 * slot keyed by its id, so a change of buttons swaps slots inside the live row
 * and the row itself never remounts (UIKit snapshots the platter).
 */
export const MiniPlayerLeadingButtons = memo(function MiniPlayerLeadingButtons({
  buttonIds,
  slotWidth,
  rowHeight,
  groupGap,
}: MiniPlayerLeadingButtonsProps) {
  const { t } = useTranslation('session');
  const navigation = useMiniPlayerNavigation();
  // The host stays mounted under the player, which pages its own track.
  const segments = useSegments();
  const playerOpen = isPlayerRoute(segments);
  const firstTransportIndex = buttonIds.findIndex((buttonId) => TRANSPORT.has(buttonId));

  const renderButton = (buttonId: MiniPlayerButtonId) => {
    switch (buttonId) {
      case 'previous':
        return (
          <MiniPlayerIconButton
            iconName="skip.previous"
            accessibilityLabel={t('playView.actionBar.previousAria')}
            onPress={navigation.onPrevious}
            disabled={!navigation.canPrevious}
            size={slotWidth}
          />
        );
      case 'next':
        return (
          <MiniPlayerIconButton
            iconName="skip.next"
            accessibilityLabel={t('playView.actionBar.nextAria')}
            onPress={navigation.onNext}
            disabled={!navigation.canNext}
            size={slotWidth}
          />
        );
      default:
        return null;
    }
  };

  return (
    <>
      {buttonIds.includes('next') && !playerOpen ? <MiniPlayerTrackPager /> : null}
      {buttonIds.map((buttonId, index) => (
        <View
          key={buttonId}
          style={[
            styles.slot,
            { width: slotWidth, height: rowHeight },
            index === firstTransportIndex && index > 0 ? { marginStart: groupGap } : null,
          ]}
        >
          {renderButton(buttonId)}
        </View>
      ))}
    </>
  );
});

const styles = StyleSheet.create({
  slot: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  action: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: opacity.disabled,
  },
});
