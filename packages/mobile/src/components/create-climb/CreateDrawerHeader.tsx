import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet, Pressable, type TextInput } from 'react-native';
import { BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { BleLightbulbButton } from '../ble/BleLightbulbButton';
import { AppMenu } from '../AppMenu';
import {
  buildCreateOverflowMenu,
  type CreateOverflowAction,
  type CreateOverflowMenuState,
} from './create-overflow-menu';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

const NAME_MAX = 80;

type CreateDrawerHeaderProps = {
  name: string;
  onChangeName: (next: string) => void;
  startingCount: number;
  finishCount: number;
  /** Bumped by the controller to pull focus into the name field (unnamed save). */
  focusSignal: number;
  onClose: () => void;
  bleConnected: boolean;
  bleConnecting: boolean;
  onToggleBle: () => void;
  /** Editor state the overflow (⋯) menu builds its rows from. */
  overflow: CreateOverflowMenuState;
  onSelectOverflowAction: (action: CreateOverflowAction) => void;
};

/**
 * Create-drawer header, mirroring the Play Drawer chrome: a close chevron on the
 * left, the always-editable climb name + start/finish counts in the centre, and
 * the BLE lightbulb on the right (connect the wall to light up the climb).
 */
export const CreateDrawerHeader = memo(function CreateDrawerHeader({
  name,
  onChangeName,
  startingCount,
  finishCount,
  focusSignal,
  onClose,
  bleConnected,
  bleConnecting,
  onToggleBle,
  overflow,
  onSelectOverflowAction,
}: CreateDrawerHeaderProps) {
  const { t } = useTranslation('climbs');
  const { t: tSettings } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  const { systemColors } = useTheme();
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus();
  }, [focusSignal]);

  const counts = `${t('mobile.create.counts.start', { count: startingCount })} · ${t('mobile.create.counts.finish', {
    count: finishCount,
  })}`;

  const overflowRows = useMemo(() => buildCreateOverflowMenu(overflow, t), [overflow, t]);
  // The menu reports a position; the rows carry what that position means, so a
  // state that drops a row (Woods, or a boulder with no frame to delete) can
  // never shift a tap onto the wrong action.
  //
  // Disabled rows are refused here as well as by all three platform menus. Every
  // action behind one guards itself too, so this is depth rather than a fix —
  // but the row set is data, and the next action added to it may not.
  const handleSelectOverflowIndex = useCallback(
    (index: number) => {
      const row = overflowRows[index];
      if (!row || row.disabled) return;
      onSelectOverflowAction(row.action);
    },
    [overflowRows, onSelectOverflowAction],
  );

  return (
    <View style={styles.row}>
      {/* NOT `createClimbForm.dismiss` — that key is a DIALOG cancel label, and
          its translations say discard ("Descartar" / "Ignorer" / "Ausblenden").
          On a close button, for a feature whose whole point is "does closing lose
          my work?", the screen-reader user was getting a stronger wrong signal
          than the sighted one. The work is kept; the hint says where. */}
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.create.actions.close')}
        accessibilityHint={t('mobile.create.actions.closeHint')}
        hitSlop={8}
        style={[styles.iconButton, { backgroundColor: systemColors.fill }]}
      >
        <Icon name="chevron.down" size={20} color={iosSystemColors.systemGray} />
      </Pressable>

      <View style={styles.center}>
        <BottomSheetTextInput
          // The native drop-in re-exports BottomSheetTextInput as RN's TextInput,
          // so the ref is a plain TextInput ref (used for focus()).
          ref={inputRef}
          value={name}
          onChangeText={onChangeName}
          placeholder={t('mobile.create.header.newClimb')}
          placeholderTextColor={systemColors.tertiaryLabel}
          maxLength={NAME_MAX}
          returnKeyType="done"
          style={[styles.nameInput, { color: systemColors.label }]}
        />
        <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.subtitle}>
          {counts}
        </Text>
      </View>

      {/* Document-level commands (what kind of climb this is, start over) live in
          the nav-bar overflow, not the action bar: that bar is a tool bar you use
          with a brush in hand, and its middle is a horizontal scroller, so a
          command placed there can scroll off-screen. That is exactly how the bare
          `copy` glyph went unfound twice. Left of the lightbulb, which is a
          stateful toggle whose position climbers track across sessions. */}
      <AppMenu
        iconName="more"
        actions={overflowRows}
        onSelectIndex={handleSelectOverflowIndex}
        accessibilityLabel={t('mobile.create.routeMenu.open')}
        style={styles.overflow}
      />

      <BleLightbulbButton
        isConnected={bleConnected}
        isScanning={bleConnecting}
        onPress={onToggleBle}
        accessibilityLabel={bleConnected ? tCommon('lightControl.disconnect') : tSettings('ble.connectBoard')}
        scanningAccessibilityHint={tSettings('ble.scanning')}
        writingAccessibilityHint={tSettings('ble.writing')}
        haptic="medium"
        size={24}
        containerSize={44}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    minHeight: 56,
    gap: spacing[2],
  },
  // A 44pt circle echoing the Play Drawer's close button. The fill is applied
  // inline from the theme (systemColors.fill) so it adapts to dark mode and
  // matches the drawer's action buttons.
  overflow: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
  },
  nameInput: {
    fontWeight: '700',
    fontSize: 17,
    textAlign: 'center',
    paddingVertical: 0,
    alignSelf: 'stretch',
  },
  subtitle: {
    marginTop: 2,
    textAlign: 'center',
  },
});
