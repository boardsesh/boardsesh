import { useEffect, useMemo, useRef } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import BottomSheet from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { BoardName, HoldState, LitUpHoldsMap } from '@boardsesh/shared-schema';
import { Sheet } from '../Sheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection } from '../../lib/haptics';
import { getEffectiveHoldStateShape, useHoldColorOverrides } from '../../lib/hold-color-overrides';
import { spacing, borderRadius } from '../../theme/tokens';
import { brushRoleColor, getPaintRoles, useBrushRoleLabels, type BrushRole } from './brush-roles';
import { HoldMarkerShapeSvg } from '../board-renderer/HoldMarkerShape';

type HoldRoleSheetProps = {
  /** The long-pressed hold, or null when the sheet is closed. */
  holdId: number | null;
  boardName: BoardName;
  litUpHoldsMap: LitUpHoldsMap;
  startingCount: number;
  finishCount: number;
  onSelectRole: (holdId: number, role: BrushRole) => void;
  onClose: () => void;
};

/**
 * Long-press role picker for a single hold. Lets the user assign Start / Hand /
 * Finish / Foot, or clear the hold. Start and Finish are disabled once two are
 * placed (unless the long-pressed hold already holds that role, so the user can
 * re-confirm or switch it).
 */
export function HoldRoleSheet({
  holdId,
  boardName,
  litUpHoldsMap,
  startingCount,
  finishCount,
  onSelectRole,
  onClose,
}: HoldRoleSheetProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const roleLabels = useBrushRoleLabels();
  const {
    overrides: holdColorOverrides,
    shapes: holdShapeOverrides,
    brushThickness,
    shapeSize,
  } = useHoldColorOverrides();
  const sheetRef = useRef<BottomSheet>(null);

  useEffect(() => {
    if (holdId != null) {
      sheetRef.current?.snapToIndex(0);
    } else {
      sheetRef.current?.close();
    }
  }, [holdId]);

  const currentState: HoldState | undefined = holdId != null ? litUpHoldsMap[holdId]?.state : undefined;

  const snapPoints = useMemo(() => ['52%', '90%'], []);
  const paintRoles = useMemo(() => getPaintRoles(boardName), [boardName]);

  const handleSelect = (role: BrushRole) => {
    if (holdId == null) return;
    hapticSelection();
    onSelectRole(holdId, role);
    onClose();
  };

  return (
    <Sheet ref={sheetRef} snapPoints={snapPoints} onClose={onClose} enablePanDownToClose fullWindowOverlay scrollable>
      <View style={styles.content}>
        <Text variant="headline" style={styles.title}>
          {t('mobile.create.holdRole.title')}
        </Text>
        <View style={styles.grid}>
          {paintRoles.map((role) => {
            const isCurrent = currentState === role;
            const atCap = (role === 'STARTING' && startingCount >= 2) || (role === 'FINISH' && finishCount >= 2);
            const disabled = atCap && !isCurrent;
            const color = brushRoleColor(boardName, role, holdColorOverrides);
            const markerDiameter = 20 * shapeSize;
            return (
              <Pressable
                key={role}
                onPress={() => handleSelect(role)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={roleLabels[role]}
                accessibilityState={{ selected: isCurrent, disabled }}
                style={[
                  styles.cell,
                  { backgroundColor: systemColors.fill },
                  isCurrent && { borderColor: color, borderWidth: 2 },
                  disabled && styles.cellDisabled,
                ]}
              >
                <View style={styles.swatch}>
                  <HoldMarkerShapeSvg
                    shape={getEffectiveHoldStateShape(role, holdShapeOverrides)}
                    color={color}
                    diameter={markerDiameter}
                    strokeWidth={Math.max(2, 2 * brushThickness)}
                    fillOpacity={isCurrent ? 0.32 : 0}
                  />
                </View>
                <Text variant="subheadline" style={styles.cellLabel}>
                  {roleLabels[role]}
                </Text>
              </Pressable>
            );
          })}
          <Pressable
            onPress={() => handleSelect('OFF')}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.create.holdRole.clear')}
            style={[styles.cell, { backgroundColor: systemColors.fill }]}
          >
            <Icon name="eraser" size={20} color={systemColors.label} />
            <Text variant="subheadline" style={styles.cellLabel}>
              {t('mobile.create.holdRole.clear')}
            </Text>
          </Pressable>
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    gap: spacing[3],
  },
  title: {
    textAlign: 'center',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
  cell: {
    width: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[3],
    borderRadius: borderRadius.md,
    borderColor: 'transparent',
    borderWidth: 2,
  },
  cellDisabled: {
    opacity: 0.4,
  },
  swatch: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellLabel: {
    fontWeight: '600',
  },
});
