import React from 'react';
import { StyleSheet, View, type ColorValue, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { Button } from '../Button';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import type { SprayEditorHoldSource, SprayHoldRole } from './spray-hold-editor-reducer';
import { SPRAY_INSPECTOR_WIDTH } from './spray-tablet-layout';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The − / + and the step arrows. */
const STEP_ICON_SIZE = 18;
/** Dimmed opacity for a control that cannot act right now. */
const DISABLED_OPACITY = 0.4;
/** The role swatch in the header. */
const ROLE_DOT_SIZE = 12;

type SprayHoldInspectorProps = {
  role: SprayHoldRole;
  source: SprayEditorHoldSource;
  /** Detector confidence 0–1, or null. Shown for a scan find. */
  confidence: number | null;
  canShrink: boolean;
  canGrow: boolean;
  onShrink: () => void;
  onGrow: () => void;
  onTrace: () => void;
  /** Touch up the outline with an add / erase brush. */
  onRefine: () => void;
  onJoin: () => void;
  onSwitchOff: () => void;
  onSwitchOn: () => void;
  onDelete: () => void;
  /** There is another hold to step to. */
  canStep: boolean;
  onPrevious: () => void;
  onNext: () => void;
  /** Put the hold down. */
  onClose: () => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * The picked hold, on iPad: a glass card that replaces the phone's chip bar,
 * with the same actions and the same rule that only a ghost can be deleted.
 *
 * It has room the chip bar does not, so it also says what the hold is — its
 * role, and whether the scan found it (and how sure it was) or the climber
 * added it — and walks the wall: Previous and Next pick the neighbouring hold in
 * reading order and frame it, which is how a long correction pass goes on a
 * big screen without hunting.
 *
 * Docked opposite the tool rail by `SprayTabletChrome`. The handlers are the
 * chip bar's, so the two layouts can never disagree about what a button does.
 */
export const SprayHoldInspector = React.memo(function SprayHoldInspector({
  role,
  source,
  confidence,
  canShrink,
  canGrow,
  onShrink,
  onGrow,
  onTrace,
  onRefine,
  onJoin,
  onSwitchOff,
  onSwitchOn,
  onDelete,
  canStep,
  onPrevious,
  onNext,
  onClose,
  style,
}: SprayHoldInspectorProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const roleColor =
    role === 'on' ? brandColors.primary : role === 'maybe' ? brandColors.accent : systemColors.secondaryLabel;

  return (
    <View style={[styles.card, style]}>
      <GlassSurface glassEffectStyle="regular" borderRadius={borderRadius.xl} style={StyleSheet.absoluteFill} />
      <View style={styles.header}>
        <View
          style={[
            styles.roleDot,
            role === 'on' ? { backgroundColor: roleColor } : styles.roleDotOutline,
            { borderColor: roleColor },
          ]}
        />
        <View style={styles.headerText}>
          <Text variant="headline" color={systemColors.label} numberOfLines={1}>
            {inspectorRoleLabel(role, t)}
          </Text>
          <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1}>
            {sourceLabel(source, confidence, t)}
          </Text>
        </View>
        <InspectorIconButton
          iconName="close"
          label={t('sprayEditor.menu.close')}
          color={systemColors.label}
          onPress={onClose}
        />
      </View>

      {role === 'on' ? (
        <View style={styles.sizeRow}>
          <Text variant="subheadline" color={systemColors.label} style={styles.sizeLabel}>
            {t('sprayEditor.inspector.size')}
          </Text>
          <InspectorIconButton
            iconName="minus"
            label={t('sprayEditor.a11y.actions.smaller')}
            color={systemColors.label}
            disabled={!canShrink}
            onPress={onShrink}
          />
          <InspectorIconButton
            iconName="plus"
            label={t('sprayEditor.a11y.actions.bigger')}
            color={systemColors.label}
            disabled={!canGrow}
            onPress={onGrow}
          />
        </View>
      ) : null}

      <View style={styles.actions}>
        {role === 'on' ? (
          <>
            <Button
              title={t('sprayEditor.chips.switchOff')}
              variant="tonal"
              size="small"
              over="surface"
              onPress={onSwitchOff}
            />
            <Button
              title={t('sprayEditor.inspector.redraw')}
              variant="tonal"
              size="small"
              over="surface"
              onPress={onTrace}
            />
            <Button
              title={t('sprayEditor.chips.refine')}
              variant="tonal"
              size="small"
              over="surface"
              onPress={onRefine}
            />
            <Button title={t('sprayEditor.chips.join')} variant="tonal" size="small" over="surface" onPress={onJoin} />
          </>
        ) : role === 'off' ? (
          <>
            <Button
              title={t('sprayEditor.chips.switchOn')}
              variant="tonal"
              size="small"
              over="surface"
              onPress={onSwitchOn}
            />
            <Button
              title={t('sprayEditor.chips.delete')}
              variant="tonal"
              size="small"
              role="destructive"
              over="surface"
              onPress={onDelete}
            />
          </>
        ) : (
          <>
            <Button
              title={t('sprayEditor.chips.keep')}
              variant="tonal"
              size="small"
              over="surface"
              onPress={onSwitchOn}
            />
            <Button
              title={t('sprayEditor.chips.switchOff')}
              variant="tonal"
              size="small"
              over="surface"
              onPress={onSwitchOff}
            />
          </>
        )}
      </View>

      {canStep ? (
        <View style={[styles.stepRow, { borderTopColor: systemColors.separator }]}>
          <InspectorIconButton
            iconName="chevron.left"
            label={t('sprayEditor.inspector.previous')}
            color={systemColors.label}
            onPress={onPrevious}
          />
          <InspectorIconButton
            iconName="chevron.right"
            label={t('sprayEditor.inspector.next')}
            color={systemColors.label}
            onPress={onNext}
          />
        </View>
      ) : null}
    </View>
  );
});

/** The role as the card's title. Literal keys, so the catalogue checks can see them. */
function inspectorRoleLabel(role: SprayHoldRole, t: Translate): string {
  if (role === 'on') return t('sprayEditor.inspector.role.on');
  if (role === 'maybe') return t('sprayEditor.inspector.role.maybe');
  return t('sprayEditor.inspector.role.off');
}

/** "Found by scan · 82%" or "Added by you". */
export function sourceLabel(source: SprayEditorHoldSource, confidence: number | null, t: Translate): string {
  if (source === 'MANUAL') return t('sprayEditor.inspector.source.manual');
  if (confidence == null) return t('sprayEditor.inspector.source.scan');
  return t('sprayEditor.inspector.source.scanConfidence', { percent: Math.round(confidence * 100) });
}

type InspectorIconButtonProps = {
  iconName: IconName;
  label: string;
  color: ColorValue;
  disabled?: boolean;
  onPress: () => void;
};

const InspectorIconButton = React.memo(function InspectorIconButton({
  iconName,
  label,
  color,
  disabled = false,
  onPress,
}: InspectorIconButtonProps) {
  const { systemColors } = useTheme();
  return (
    <PressableSurface
      onPress={onPress}
      disabled={disabled}
      feedback="scale"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={[styles.iconButton, { backgroundColor: systemColors.fill }, disabled ? styles.disabled : null]}
    >
      <Icon name={iconName} size={STEP_ICON_SIZE} color={color} />
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
  card: {
    width: SPRAY_INSPECTOR_WIDTH,
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
    padding: spacing[3],
    gap: spacing[3],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  roleDot: {
    width: ROLE_DOT_SIZE,
    height: ROLE_DOT_SIZE,
    borderRadius: ROLE_DOT_SIZE / 2,
    borderWidth: 2,
  },
  roleDotOutline: {
    borderStyle: 'dashed',
  },
  sizeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  sizeLabel: {
    flex: 1,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
  stepRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing[2],
  },
  iconButton: {
    width: glassSize.capsule,
    height: glassSize.capsule,
    borderRadius: glassSize.capsule / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: DISABLED_OPACITY,
  },
});
