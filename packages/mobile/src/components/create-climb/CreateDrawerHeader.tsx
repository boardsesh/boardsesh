import { memo, useEffect, useRef, type ComponentProps } from 'react';
import { View, StyleSheet, Pressable, type TextInput } from 'react-native';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { BleLightbulbButton } from '../ble/BleLightbulbButton';
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

  return (
    <View style={styles.row}>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t('createClimbForm.dismiss')}
        hitSlop={8}
        style={[styles.iconButton, { backgroundColor: systemColors.fill }]}
      >
        <Icon name="chevron.down" size={20} color={iosSystemColors.systemGray} />
      </Pressable>

      <View style={styles.center}>
        <BottomSheetTextInput
          // gorhom types its ref as a gesture-handler-wrapped TextInput; cast to
          // the component's own ref prop type and keep a plain TextInput ref for focus().
          ref={inputRef as unknown as ComponentProps<typeof BottomSheetTextInput>['ref']}
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

      <BleLightbulbButton
        isConnected={bleConnected}
        isScanning={bleConnecting}
        onPress={onToggleBle}
        accessibilityLabel={bleConnected ? tCommon('lightControl.disconnect') : tSettings('ble.connectBoard')}
        scanningAccessibilityHint={tSettings('ble.scanning')}
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
