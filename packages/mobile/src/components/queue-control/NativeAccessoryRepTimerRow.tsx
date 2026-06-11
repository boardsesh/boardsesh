import { StyleSheet, View } from 'react-native';
import { useOptionalBoardProvider } from '@boardsesh/board-react';
import type { Climb } from '@boardsesh/queue';
import { useTheme } from '../../providers/theme-provider';
import { glassSize } from '../../theme/layout';
import { spacing } from '../../theme/tokens';
import { LogAscentToolbarButton } from './LogAscentToolbarButton';
import { RepTimerDisplay } from './RepTimerCapsule';

type AccessoryPlacement = 'regular' | 'inline';

type NativeAccessoryRepTimerRowProps = {
  placement: AccessoryPlacement;
  width: number;
  climb: Climb;
};

const ACCESSORY_LEADING_INSET = spacing[3];
const ACCESSORY_TRAILING_INSET = spacing[3];

export function NativeAccessoryRepTimerRow({ placement, width, climb }: NativeAccessoryRepTimerRowProps) {
  const board = useOptionalBoardProvider();
  const { systemColors } = useTheme();
  const rowHeight = placement === 'inline' ? glassSize.inline : glassSize.standard;

  return (
    <View style={[styles.row, { width, height: rowHeight }]}>
      <View style={styles.timerSlot}>
        <RepTimerDisplay
          lastSavedTickAt={board?.lastSavedTickAt ?? null}
          labelColor={systemColors.secondaryLabel}
          valueColor={systemColors.label}
          align="left"
        />
      </View>
      <View style={[styles.tickSlot, { width: glassSize.inline, height: rowHeight }]}>
        <LogAscentToolbarButton climb={climb} size={glassSize.inline} iconSize={24} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: ACCESSORY_LEADING_INSET,
    paddingRight: ACCESSORY_TRAILING_INSET,
  },
  timerSlot: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  tickSlot: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
});
