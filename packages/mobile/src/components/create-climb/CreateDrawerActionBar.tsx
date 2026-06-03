import { memo, useMemo } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { ActionButton, drawerActionBarStyles } from '../drawer-action-bar/DrawerActionBar';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection } from '../../lib/haptics';
import { brandColors } from '../../theme/colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { brushRoleColor, getPaintRoles, useBrushRoleLabels, type BrushRole } from './brush-roles';
import { deriveSaveButtonView } from './save-button-view';
import type { SaveButtonState } from './use-create-climb-screen';

// Looked up dynamically by role below; mark each resolvable key (one per line,
// namespace-qualified) so the orphan checker keeps them.
// i18n-keep climbs.mobile.create.brush.start
// i18n-keep climbs.mobile.create.brush.hand
// i18n-keep climbs.mobile.create.brush.finish
// i18n-keep climbs.mobile.create.brush.foot

type CreateDrawerActionBarProps = {
  boardName: BoardName;
  selectedBrush: BrushRole;
  onSelectBrush: (role: BrushRole) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  canSetActive: boolean;
  onSetActive: () => void;
  saveState: SaveButtonState;
  onSave: () => void;
  onToggleHeatmap?: () => void;
  heatmapActive?: boolean;
};

/**
 * The create-drawer two-row action bar, built on the shared drawer-action-bar
 * grammar. Row 1 (where the Play Drawer's play controls sit) is the five brush
 * chips; Row 2 is the other actions: undo / redo / clear, then set-active and
 * the save state-machine button.
 */
export const CreateDrawerActionBar = memo(function CreateDrawerActionBar({
  boardName,
  selectedBrush,
  onSelectBrush,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClear,
  canSetActive,
  onSetActive,
  saveState,
  onSave,
  onToggleHeatmap,
  heatmapActive = false,
}: CreateDrawerActionBarProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const roleLabels = useBrushRoleLabels();

  const paintRoles = useMemo(() => getPaintRoles(boardName), [boardName]);
  const roleChips = useMemo(
    () => paintRoles.map((role) => ({ role, label: roleLabels[role], color: brushRoleColor(boardName, role) })),
    [boardName, paintRoles, roleLabels],
  );

  const handleSelect = (role: BrushRole) => {
    hapticSelection();
    onSelectBrush(role);
  };

  return (
    <View style={drawerActionBarStyles.container}>
      <View style={styles.brushRow}>
        {roleChips.map(({ role, label, color }) => {
          const selected = selectedBrush === role;
          return (
            <Pressable
              key={role}
              onPress={() => handleSelect(role)}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ selected }}
              style={[
                styles.chip,
                { backgroundColor: systemColors.fill },
                selected && { borderColor: color, borderWidth: 2 },
              ]}
            >
              <View style={[styles.swatch, { backgroundColor: color }]} />
              <Text variant="caption1" style={styles.chipLabel} numberOfLines={1}>
                {label}
              </Text>
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => handleSelect('OFF')}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.create.brush.erase')}
          accessibilityState={{ selected: selectedBrush === 'OFF' }}
          style={[
            styles.chip,
            { backgroundColor: systemColors.fill },
            selectedBrush === 'OFF' && { borderColor: systemColors.label, borderWidth: 2 },
          ]}
        >
          <Icon name="eraser" size={18} color={systemColors.label} />
          <Text variant="caption1" style={styles.chipLabel} numberOfLines={1}>
            {t('mobile.create.brush.erase')}
          </Text>
        </Pressable>
      </View>

      <View style={drawerActionBarStyles.rowSecondary}>
        <ActionButton
          size="sm"
          iconName="undo"
          onPress={onUndo}
          disabled={!canUndo}
          accessibilityLabel={t('mobile.create.actions.undo')}
        />
        <ActionButton
          size="sm"
          iconName="redo"
          onPress={onRedo}
          disabled={!canRedo}
          accessibilityLabel={t('mobile.create.actions.redo')}
        />
        <ActionButton
          size="sm"
          iconName="delete"
          onPress={onClear}
          accessibilityLabel={t('mobile.create.actions.clear')}
        />
        {onToggleHeatmap ? (
          <ActionButton
            size="sm"
            iconName="flame"
            onPress={onToggleHeatmap}
            active={heatmapActive}
            activeColor={brandColors.primary}
            accessibilityLabel={heatmapActive ? t('search.holds.hideHeatmap') : t('search.holds.showHeatmap')}
          />
        ) : null}

        <View style={drawerActionBarStyles.spacer} />

        <ActionButton
          size="sm"
          iconName="play.circle"
          onPress={onSetActive}
          disabled={!canSetActive}
          accessibilityLabel={t('mobile.create.actions.setActive')}
        />
        <SaveButton saveState={saveState} onSave={onSave} />
      </View>
    </View>
  );
});

function SaveButton({ saveState, onSave }: { saveState: SaveButtonState; onSave: () => void }) {
  const { t } = useTranslation('climbs');
  const view = deriveSaveButtonView(saveState, t);

  return (
    <Button
      title={view.title}
      icon={view.icon ?? undefined}
      variant="filled"
      size="small"
      // Success keeps the static green fill (white-legible in both schemes; the
      // lifted dark success tint would fail white-on-fill). For the default tint
      // we pass nothing so the filled Button uses its own scheme-aware
      // `primaryFill` (lifts to #7C3AED in dark), matching every other CTA.
      tintColor={view.tint === 'success' ? brandColors.success : undefined}
      disabled={view.disabled}
      onPress={onSave}
    />
  );
}

const styles = StyleSheet.create({
  brushRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    gap: spacing[2],
  },
  chip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[1],
    borderRadius: borderRadius.md,
    borderColor: 'transparent',
    borderWidth: 2,
  },
  swatch: {
    width: 18,
    height: 18,
    borderRadius: 9,
  },
  chipLabel: {
    fontWeight: '600',
  },
});
