import { memo, useCallback, useMemo, useEffect, useRef } from 'react';
import { View, StyleSheet, type View as NativeView } from 'react-native';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';
import type { BoardHoldTarget } from '../../lib/create-board-holds';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

type Props = {
  holds: BoardHoldTarget[];
  roles: LitUpHoldsMap;
  onPaint: (id: number) => void;
  onChooseRole: (id: number, anchor?: { x: number; y: number }) => void;
};
const keyExtractor = (hold: BoardHoldTarget) => String(hold.id);
const HoldRow = memo(function HoldRow({
  hold,
  role,
  onPaint,
  onChooseRole,
}: { hold: BoardHoldTarget; role: string } & Pick<Props, 'onPaint' | 'onChooseRole'>) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const roleLabel =
    role === 'STARTING'
      ? t('mobile.create.brush.start')
      : role === 'HAND'
        ? t('mobile.create.brush.hand')
        : role === 'FINISH'
          ? t('mobile.create.brush.finish')
          : role === 'FOOT'
            ? t('mobile.create.brush.foot')
            : t('mobile.boardAccessibility.unlit');
  const paint = useCallback(() => onPaint(hold.id), [hold.id, onPaint]);
  const rowRef = useRef<NativeView>(null);
  const anchorRevision = useRef(0);
  useEffect(
    () => () => {
      anchorRevision.current++;
    },
    [hold.id],
  );
  const chooseRole = useCallback(() => {
    const readRevision = ++anchorRevision.current;
    if (!rowRef.current) {
      onChooseRole(hold.id);
      return;
    }
    rowRef.current.measureInWindow((x, y, width, height) => {
      if (readRevision !== anchorRevision.current) return;
      onChooseRole(hold.id, width > 0 && height > 0 ? { x: x + width / 2, y: y + height / 2 } : undefined);
    });
  }, [hold.id, onChooseRole]);
  const action = useCallback(
    (event: { nativeEvent: { actionName: string } }) => {
      if (event.nativeEvent.actionName === 'chooseRole') chooseRole();
    },
    [chooseRole],
  );
  return (
    <PressableSurface
      ref={rowRef}
      feedback="opacity"
      onPress={paint}
      onLongPress={chooseRole}
      accessibilityLabel={t('mobile.boardAccessibility.hold', { id: hold.id, role: roleLabel })}
      accessibilityHint={t('mobile.boardAccessibility.paintHint')}
      accessibilityActions={[{ name: 'chooseRole', label: t('mobile.boardAccessibility.chooseRole') }]}
      onAccessibilityAction={action}
      style={[styles.row, { borderBottomColor: systemColors.separator }]}
    >
      <Text>{t('mobile.boardAccessibility.hold', { id: hold.id, role: roleLabel })}</Text>
    </PressableSurface>
  );
});
/** Replaces the drawing area with a full-height virtualized alternative, never nested in a ScrollView. */
export function AccessibleHoldList({ holds, roles, onPaint, onChooseRole }: Props) {
  const orderedHolds = useMemo(
    () => [...holds].sort((first, second) => first.cy - second.cy || first.cx - second.cx || first.id - second.id),
    [holds],
  );
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<BoardHoldTarget>) => (
      <HoldRow hold={item} role={roles[item.id]?.state ?? 'OFF'} onPaint={onPaint} onChooseRole={onChooseRole} />
    ),
    [roles, onPaint, onChooseRole],
  );
  return (
    <View style={styles.list}>
      <FlashList data={orderedHolds} renderItem={renderItem} keyExtractor={keyExtractor} extraData={roles} />
    </View>
  );
}
const styles = StyleSheet.create({
  list: { flex: 1 },
  row: { minHeight: 48, padding: spacing[4], borderBottomWidth: StyleSheet.hairlineWidth },
});
