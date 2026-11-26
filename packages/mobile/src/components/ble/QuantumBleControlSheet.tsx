import { useCallback } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { BoardLayerColorKey } from '@boardsesh/board-layers';
import type { QuantumClimbLightTargetError, QuantumLayerAction } from '../../lib/ble/quantum-climb-lights';
import { useTheme } from '../../providers/theme-provider';
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

export type QuantumLayerRemovalRow = Readonly<{
  controllerUserUuid: string;
  controllerRouteUuid: string;
  colorKey?: BoardLayerColorKey;
  colorHex: string;
}>;

type QuantumBleControlSheetProps = {
  visible: boolean;
  rows: readonly QuantumLayerControlRow[];
  targetError: QuantumClimbLightTargetError | null;
  removals: readonly QuantumLayerRemovalRow[];
  busyAction: string | number | null;
  actionFailed: boolean;
  onLayerPress: (row: QuantumLayerControlRow) => void;
  onRemove: (row: QuantumLayerRemovalRow) => void;
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
    default:
      return assertNever(colorKey);
  }
}

function assertNever(colorKey: never): never {
  throw new Error(`Unsupported Quantum layer color: ${String(colorKey)}`);
}

function targetErrorLabel(reason: QuantumClimbLightTargetError | null, t: TFunction<'common'>): string {
  if (reason === 'missing-route') return t('lightControl.quantum.routeMissing');
  if (reason === 'missing-geometry' || reason === 'missing-led-position') {
    return t('lightControl.quantum.geometryMissing');
  }
  if (reason === 'multi-frame-unsupported') return t('lightControl.quantum.multiFrameUnsupported');
  if (reason === 'invalid-frames') return t('lightControl.quantum.invalidFrames');
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
    case 'active':
      return t('lightControl.quantum.active');
    case 'unavailable':
      if (action.reason === 'color-in-use') return t('lightControl.quantum.foreign');
      if (action.reason === 'board-full') return t('lightControl.quantum.boardFull');
      return targetErrorLabel(targetError, t);
  }
}

/** Explicit Quantum roster controls. Navigation and queue gestures never call
 * these handlers; the climber chooses a color for this phone's player. */
export function QuantumBleControlSheet({
  visible,
  rows,
  targetError,
  removals,
  busyAction,
  actionFailed,
  onLayerPress,
  onRemove,
  onDisconnect,
  onClose,
}: QuantumBleControlSheetProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const handleDisconnect = useCallback(() => {
    onDisconnect();
    onClose();
  }, [onClose, onDisconnect]);

  return (
    <ModalSheet visible={visible} enableDynamicSizing onClose={onClose} enablePanDownToClose scrollable>
      <View style={styles.content}>
        {rows.map((row) => {
          const busy = busyAction === row.slot;
          const canPress = busyAction === null && (row.action.kind === 'light' || row.action.kind === 'replace');
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
            leading={<Icon name="warning" size={22} color={systemColors.error} />}
            showSeparator
          />
        ) : null}

        {removals.map((row) => (
          <ListRow
            key={row.controllerUserUuid}
            title={
              row.colorKey
                ? t('lightControl.quantum.removeColor', { color: colorLabel(row.colorKey, t) })
                : t('lightControl.quantum.remove')
            }
            leading={<View style={[styles.colorDot, { backgroundColor: row.colorHex }]} />}
            trailing={busyAction === row.controllerUserUuid ? <ActivityIndicator size="small" /> : undefined}
            onPress={busyAction === null ? () => onRemove(row) : undefined}
            showSeparator
          />
        ))}

        <ListRow
          title={t('lightControl.disconnect')}
          leading={<Icon name="bluetooth.off" size={22} color={systemColors.error} />}
          onPress={busyAction === null ? handleDisconnect : undefined}
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
