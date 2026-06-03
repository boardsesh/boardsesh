import { useMemo } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import type { BoardName } from '@boardsesh/shared-schema';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { ActivityIndicator } from '../ActivityIndicator';
import { useTheme } from '../../providers/theme-provider';
import { hapticSelection, hapticLight } from '../../lib/haptics';
import { brandColors } from '../../theme/colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { PAINT_ROLES, brushRoleColor, useBrushRoleLabels, type BrushRole } from './brush-roles';

// The save button's visual state, derived by the controller from auth + the
// saved-climb snapshot + in-flight state.
export type SaveButtonState = 'ready' | 'saving' | 'justSaved' | 'editLocked' | 'login';

type BrushBarProps = {
  boardName: BoardName;
  selectedBrush: BrushRole;
  onSelectBrush: (role: BrushRole) => void;
  /** Paintable roles to show as chips. Defaults to the Aurora set (incl. Foot);
   * MoonBoard passes Start/Hand/Finish only (no foot). */
  paintRoles?: ReadonlyArray<Exclude<BrushRole, 'OFF'>>;
  startingCount: number;
  finishCount: number;
  // Secondary controls.
  saveState: SaveButtonState;
  onSave: () => void;
  onClear: () => void;
  onOpenSettings: () => void;
  onSetActive: () => void;
  canSetActive: boolean;
  /** Heatmap toggle is a placeholder until the heatmap lands; disabled when undefined. */
  onToggleHeatmap?: () => void;
  heatmapActive?: boolean;
};

// Looked up dynamically by role below; mark each resolvable key (one per line,
// namespace-qualified) so the orphan checker keeps them.
// i18n-keep climbs.mobile.create.brush.start
// i18n-keep climbs.mobile.create.brush.hand
// i18n-keep climbs.mobile.create.brush.finish
// i18n-keep climbs.mobile.create.brush.foot
const SAVE_ICON: Record<SaveButtonState, IconName> = {
  ready: 'square.and.arrow.up.on.square',
  saving: 'square.and.arrow.up.on.square',
  justSaved: 'check.small',
  editLocked: 'lock',
  login: 'person',
};

/**
 * Persistent bottom bar for the create-climb editor: brush role chips + the
 * eraser on top, a start/finish counter, and the secondary control cluster
 * (heatmap placeholder, settings, clear, save, set-active). Pure presentational
 * — all state and callbacks come from the controller via the screen.
 */
export function BrushBar({
  boardName,
  selectedBrush,
  onSelectBrush,
  paintRoles = PAINT_ROLES,
  startingCount,
  finishCount,
  saveState,
  onSave,
  onClear,
  onOpenSettings,
  onSetActive,
  canSetActive,
  onToggleHeatmap,
  heatmapActive = false,
}: BrushBarProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const roleLabels = useBrushRoleLabels();

  const roleChips = useMemo(
    () =>
      paintRoles.map((role) => ({
        role,
        label: roleLabels[role],
        color: brushRoleColor(boardName, role),
      })),
    [boardName, roleLabels, paintRoles],
  );

  const handleSelect = (role: BrushRole) => {
    hapticSelection();
    onSelectBrush(role);
  };

  return (
    <View style={[styles.bar, { backgroundColor: systemColors.secondaryBackground }]}>
      <View style={styles.chipRow}>
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
              <Text variant="footnote" style={styles.chipLabel} numberOfLines={1}>
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
          <Icon name="eraser" size={16} color={systemColors.label as string} />
          <Text variant="footnote" style={styles.chipLabel} numberOfLines={1}>
            {t('mobile.create.brush.erase')}
          </Text>
        </Pressable>
      </View>

      <View style={styles.controlRow}>
        <View style={styles.counters}>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('mobile.create.counts.start', { count: startingCount })}
          </Text>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('mobile.create.counts.finish', { count: finishCount })}
          </Text>
        </View>

        <View style={styles.actions}>
          <SecondaryButton
            icon="flame"
            label={t('mobile.create.actions.heatmap')}
            onPress={onToggleHeatmap}
            active={heatmapActive}
            disabled={!onToggleHeatmap}
          />
          <SecondaryButton icon="settings" label={t('mobile.create.actions.settings')} onPress={onOpenSettings} />
          <SecondaryButton icon="delete" label={t('mobile.create.actions.clear')} onPress={onClear} />
          <SecondaryButton
            icon="play.circle"
            label={t('mobile.create.actions.setActive')}
            onPress={onSetActive}
            disabled={!canSetActive}
          />
          <Pressable
            onPress={() => {
              if (saveState === 'saving' || saveState === 'editLocked') return;
              hapticLight();
              onSave();
            }}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.create.actions.save')}
            disabled={saveState === 'saving' || saveState === 'editLocked'}
            style={[styles.saveButton, saveState === 'editLocked' && styles.saveButtonDisabled]}
          >
            {saveState === 'saving' ? (
              <ActivityIndicator size="small" color={brandColors.primary} />
            ) : (
              <Icon
                name={SAVE_ICON[saveState]}
                size={22}
                color={saveState === 'editLocked' ? (systemColors.tertiaryLabel as string) : brandColors.primary}
              />
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function SecondaryButton({
  icon,
  label,
  onPress,
  active = false,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onPress?: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  const { systemColors } = useTheme();
  const color = disabled
    ? (systemColors.tertiaryLabel as string)
    : active
      ? brandColors.primary
      : (systemColors.label as string);
  return (
    <Pressable
      onPress={() => {
        if (disabled || !onPress) return;
        hapticLight();
        onPress();
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.secondaryButton}
    >
      <Icon name={icon} size={22} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    paddingHorizontal: spacing[3],
    paddingTop: spacing[2],
    gap: spacing[2],
  },
  chipRow: {
    flexDirection: 'row',
    gap: spacing[2],
  },
  chip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[2],
    borderRadius: borderRadius.md,
    borderColor: 'transparent',
    borderWidth: 2,
  },
  swatch: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  chipLabel: {
    fontWeight: '600',
  },
  controlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  counters: {
    gap: 2,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
  secondaryButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButton: {
    width: 44,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
});
