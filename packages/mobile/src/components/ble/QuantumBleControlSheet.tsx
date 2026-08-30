import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { BoardLayerColorKey } from '@boardsesh/board-layers';
import type { QuantumClimbLightTargetError, QuantumLayerAction } from '../../lib/ble/quantum-climb-lights';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';
import { Icon } from '../Icon';
import { ListRow } from '../ListRow';
import { ModalSheet } from '../ModalSheet';

export type QuantumLayerControlRow = Readonly<{
  slot: number;
  colorKey: BoardLayerColorKey;
  colorHex: string;
  action: QuantumLayerAction;
}>;

type QuantumBleControlSheetProps = {
  visible: boolean;
  rows: readonly QuantumLayerControlRow[];
  targetError: QuantumClimbLightTargetError | null;
  busySlot: number | null;
  clearing: boolean;
  actionFailed: boolean;
  hasActivePlayers: boolean;
  onLayerPress: (row: QuantumLayerControlRow) => void;
  onClearAll: () => void;
  onDisconnect: () => void;
  onClose: () => void;
};

function colorLabel(colorKey: BoardLayerColorKey, t: TFunction<'common'>): string {
  switch (colorKey) {
    case 'green':
      return t('lightControl.quantum.colors.green');
    case 'cyan':
      return t('lightControl.quantum.colors.cyan');
    case 'magenta':
      return t('lightControl.quantum.colors.magenta');
    case 'yellow':
      return t('lightControl.quantum.colors.yellow');
  }
}

function targetErrorLabel(reason: QuantumClimbLightTargetError | null, t: TFunction<'common'>): string {
  if (reason === 'missing-route') return t('lightControl.quantum.routeMissing');
  if (reason === 'missing-geometry' || reason === 'missing-led-position') {
    return t('lightControl.quantum.geometryMissing');
  }
  if (reason === 'too-many-diodes') return t('lightControl.quantum.tooManyHolds');
  return t('lightControl.quantum.noClimb');
}

function actionLabel(
  action: QuantumLayerAction,
  targetError: QuantumClimbLightTargetError | null,
  t: TFunction<'common'>,
): string {
  switch (action.kind) {
    case 'light':
      return t('lightControl.quantum.light');
    case 'replace':
      return t('lightControl.quantum.replace');
    case 'remove':
      return t('lightControl.quantum.remove');
    case 'unavailable':
      if (action.reason === 'color-in-use') return t('lightControl.quantum.foreign');
      if (action.reason === 'board-full') return t('lightControl.quantum.boardFull');
      return targetErrorLabel(targetError, t);
  }
}

/** Explicit Quantum roster controls. Navigation and queue gestures never call
 * these handlers; the climber chooses a fixed color slot here. */
export function QuantumBleControlSheet({
  visible,
  rows,
  targetError,
  busySlot,
  clearing,
  actionFailed,
  hasActivePlayers,
  onLayerPress,
  onClearAll,
  onDisconnect,
  onClose,
}: QuantumBleControlSheetProps) {
  const { t } = useTranslation('common');
  const [confirmingClear, setConfirmingClear] = useState(false);

  useEffect(() => {
    if (!visible || !hasActivePlayers) setConfirmingClear(false);
  }, [hasActivePlayers, visible]);

  const handleDisconnect = useCallback(() => {
    onDisconnect();
    onClose();
  }, [onClose, onDisconnect]);

  return (
    <ModalSheet visible={visible} enableDynamicSizing onClose={onClose} enablePanDownToClose scrollable>
      <View style={styles.content}>
        {rows.map((row) => {
          const busy = busySlot === row.slot;
          const canPress = !clearing && busySlot === null && row.action.kind !== 'unavailable';
          const translatedColor = colorLabel(row.colorKey, t);
          return (
            <ListRow
              key={row.slot}
              title={t('lightControl.quantum.layerTitle', { color: translatedColor })}
              subtitle={actionLabel(row.action, targetError, t)}
              leading={<View style={[styles.colorDot, { backgroundColor: row.colorHex }]} />}
              trailing={busy ? <ActivityIndicator size="small" /> : undefined}
              onPress={canPress ? () => onLayerPress(row) : undefined}
              accessibilityLabel={t('lightControl.quantum.layerAction', {
                color: translatedColor,
                action: actionLabel(row.action, targetError, t),
              })}
              showSeparator
            />
          );
        })}

        {actionFailed ? (
          <ListRow
            title={t('lightControl.quantum.actionFailed')}
            leading={<Icon name="warning" size={22} color={iosSystemColors.systemRed} />}
            showSeparator
          />
        ) : null}

        {hasActivePlayers && confirmingClear ? (
          <>
            <ListRow
              title={t('lightControl.quantum.clearQuestion')}
              leading={<Icon name="lightbulb.slash" size={22} color={iosSystemColors.systemRed} />}
              showSeparator
            />
            <ListRow
              title={t('lightControl.quantum.clearConfirm')}
              leading={<Icon name="check.small" size={22} color={iosSystemColors.systemRed} />}
              trailing={clearing ? <ActivityIndicator size="small" /> : undefined}
              onPress={clearing || busySlot !== null ? undefined : onClearAll}
              showSeparator
            />
            <ListRow
              title={t('lightControl.quantum.clearCancel')}
              leading={<Icon name="close" size={22} />}
              onPress={clearing ? undefined : () => setConfirmingClear(false)}
              showSeparator
            />
          </>
        ) : hasActivePlayers ? (
          <ListRow
            title={t('lightControl.quantum.clearStart')}
            subtitle={t('lightControl.quantum.clearStartSubtitle')}
            leading={<Icon name="lightbulb.slash" size={22} color={iosSystemColors.systemRed} />}
            onPress={busySlot === null ? () => setConfirmingClear(true) : undefined}
            showSeparator
          />
        ) : null}

        <ListRow
          title={t('lightControl.disconnect')}
          leading={<Icon name="bluetooth.off" size={22} color={iosSystemColors.systemRed} />}
          onPress={busySlot === null && !clearing ? handleDisconnect : undefined}
          showSeparator={false}
        />
      </View>
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing[2],
  },
  colorDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.28)',
  },
});
