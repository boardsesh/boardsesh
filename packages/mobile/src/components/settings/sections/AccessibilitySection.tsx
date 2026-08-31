import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CvdType } from '../../../lib/color-contrast-oracle';
import { Pressable, StyleSheet, View, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toBoardName } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import { Button } from '../../Button';
import { Icon } from '../../Icon';
import { ListRow } from '../../ListRow';
import { ModalSheet } from '../../ModalSheet';
import { SectionHeader } from '../../SectionHeader';
import { SegmentedControl } from '../../SegmentedControl';
import { SwitchRow } from '../../SwitchRow';
import { Text } from '../../Text';
import { PaletteCarousel } from '../../board-look/PaletteCarousel';
import { HoldMarkerShapeSvg } from '../../board-renderer/HoldMarkerShape';
import { useTheme } from '../../../providers/theme-provider';
import { useActiveBoard } from '../../../lib/graphql/use-active-board';
import { useBoardPreviewClimb } from '../../../hooks/use-board-preview-climb';
import { evaluateRoleSeparation, type CvdRoleVerdict } from '../../../lib/cvd-role-verdict';
import { matchingCvdPaletteId } from '../../../lib/cvd-palette-presets';
import {
  applyCvdPaletteCard,
  selectedCvdPaletteCardId,
  type CvdPaletteOptionId,
} from '../../../lib/board-render/cvd-palette-options';
import {
  clearCustomHoldColors,
  loadCustomHoldColors,
  rememberCustomHoldColors,
} from '../../../lib/board-render/custom-hold-colors';
import type { BoardseshRenderSettings } from '../../../lib/board-render-settings';
import { OkhslColorPicker } from '../OkhslColorPicker';
import { MarkerMultiplierSlider } from '../MarkerMultiplierSlider';
import {
  DEFAULT_HOLD_COLOR_SIGNATURE,
  DEFAULT_HOLD_BRUSH_THICKNESS,
  DEFAULT_HOLD_MARKER_SHAPE,
  DEFAULT_HOLD_SHAPE_SIZE,
  HOLD_MARKER_SHAPES,
  MAX_HOLD_BRUSH_THICKNESS,
  MAX_HOLD_SHAPE_SIZE,
  MIN_HOLD_BRUSH_THICKNESS,
  MIN_HOLD_SHAPE_SIZE,
  HOLD_COLOR_OVERRIDE_ROLES,
  getDefaultHoldRoleColor,
  getEffectiveHoldRoleColor,
  getEffectiveHoldRoleShape,
  normalizeBrushThickness,
  normalizeHoldShapeSize,
  useHoldColorOverrides,
  type HoldColorOverrideRole,
  type HoldColorOverrides,
  type HoldMarkerShape,
} from '../../../lib/hold-color-overrides';
import { borderRadius, spacing } from '../../../theme/tokens';

type ColorMode = 'default' | 'user';

type AccessibilitySectionProps = {
  /**
   * What the climber's own settings ask for (`default` resolved to the app
   * default), NOT the effective mode. Marker shape, brush and size only draw in
   * Classic — the Boardsesh silhouette is itself the shape — and the effective
   * mode falls back to Classic while the capability probe is unanswered, which
   * would flash those rows at someone who is on the Boardsesh drawing.
   */
  requestedMode: 'classic' | 'boardsesh';
  /**
   * `false` means the installed binary cannot draw the Boardsesh mode, so the
   * board really is Classic whatever was asked for. `null` (unanswered) is not
   * enough to claim that.
   */
  boardseshRendererAvailable: boolean | null;
  boardsesh: BoardseshRenderSettings;
  setBoardseshField: <Field extends keyof BoardseshRenderSettings>(
    field: Field,
    value: BoardseshRenderSettings[Field],
  ) => void;
};

function labelForRole(t: TFunction<'common'>, role: HoldColorOverrideRole): string {
  switch (role) {
    case 'STARTING':
      return t('mobile.more.accessibility.roles.starting');
    case 'HAND':
      return t('mobile.more.accessibility.roles.hand');
    case 'FINISH':
      return t('mobile.more.accessibility.roles.finish');
    case 'FOOT':
      return t('mobile.more.accessibility.roles.foot');
  }
}

function labelForShape(t: TFunction<'common'>, shape: HoldMarkerShape): string {
  switch (shape) {
    case 'circle':
      return t('mobile.more.accessibility.shapes.circle');
    case 'triangle-up':
      return t('mobile.more.accessibility.shapes.triangleUp');
    case 'triangle-down':
      return t('mobile.more.accessibility.shapes.triangleDown');
    case 'square':
      return t('mobile.more.accessibility.shapes.square');
    case 'diamond':
      return t('mobile.more.accessibility.shapes.diamond');
    case 'octagon':
      return t('mobile.more.accessibility.shapes.octagon');
  }
}

function boardNameFromActiveBoard(boardType: string | undefined): BoardName {
  return toBoardName(boardType) ?? 'kilter';
}

/**
 * The vision types the verdict can name, borrowing the palette rail's own card
 * titles so the line and the card a climber then taps say the same word.
 */
function labelForVision(t: TFunction<'common'>, vision: CvdType): string {
  switch (vision) {
    case 'deuteranopia':
      return t('mobile.more.boardLook.accessibility.cvdPalette.presets.deuteranopia');
    case 'protanopia':
      return t('mobile.more.boardLook.accessibility.cvdPalette.presets.protanopia');
    case 'tritanopia':
      return t('mobile.more.boardLook.accessibility.cvdPalette.presets.tritanopia');
  }
}

/**
 * The colour-vision check in words.
 *
 * `null` for a verdict the oracle could not compute — better to say nothing than
 * to guess.
 */
function verdictLine(t: TFunction<'common'>, verdict: CvdRoleVerdict): string | null {
  switch (verdict.kind) {
    case 'clear':
      return t('mobile.more.accessibility.cvd.verdict.clear');
    case 'close':
      return t('mobile.more.accessibility.cvd.verdict.close', {
        vision: labelForVision(t, verdict.vision),
        first: labelForRole(t, verdict.roles[0]),
        second: labelForRole(t, verdict.roles[1]),
      });
    case 'faint':
      return t('mobile.more.accessibility.cvd.verdict.faint', { role: labelForRole(t, verdict.role) });
    case 'unknown':
      return null;
  }
}

function MarkerSwatch({
  color,
  shape,
  thickness = DEFAULT_HOLD_BRUSH_THICKNESS,
  size = DEFAULT_HOLD_SHAPE_SIZE,
}: {
  color: ColorValue;
  shape: HoldMarkerShape;
  thickness?: number;
  size?: number;
}) {
  const { systemColors } = useTheme();
  const strokeWidth = Math.max(1.5, 2.25 * thickness);
  const shapeSize = normalizeHoldShapeSize(size);
  const diameter = 20 * shapeSize;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.swatch, { borderColor: systemColors.separator }]}
    >
      <HoldMarkerShapeSvg
        shape={shape}
        color={typeof color === 'string' ? color : '#000000'}
        diameter={diameter}
        strokeWidth={strokeWidth}
        fillOpacity={0.25}
      />
    </View>
  );
}

export function AccessibilitySection({
  requestedMode,
  boardseshRendererAvailable,
  boardsesh,
  setBoardseshField,
}: AccessibilitySectionProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const { data: activeBoard } = useActiveBoard();
  const boardName = boardNameFromActiveBoard(activeBoard?.boardType);
  const {
    overrides,
    shapes,
    brushThickness,
    shapeSize,
    setRoleOverride,
    setRoleMarkerOverride,
    setBrushThickness,
    setShapeSize,
    resetOverrides,
    renderSignature,
  } = useHoldColorOverrides();
  const [selectedRole, setSelectedRole] = useState<HoldColorOverrideRole | null>(null);
  const [thicknessSheetOpen, setThicknessSheetOpen] = useState(false);
  const [sizeSheetOpen, setSizeSheetOpen] = useState(false);
  // The marker shape / brush / size only draw in Classic, so they are shown
  // only when the drawing is KNOWN to be classic — not merely resolving that
  // way. `resolveEffectiveRenderSettings` falls back to classic while the
  // capability probe is unanswered, so keying off the effective mode alone
  // showed shape controls to a climber on the Boardsesh drawing for as long as
  // that answer took. Classic is certain in exactly two cases: they chose it, or
  // the installed binary cannot draw the other one.
  const isClassic = requestedMode === 'classic' || boardseshRendererAvailable === false;
  // renderSignature is buildHoldRenderOverrideSignature(markerOverrides), so this
  // alone is equivalent to hasHoldMarkerOverrides(markerOverrides).
  const hasMarkerOverrides = renderSignature !== DEFAULT_HOLD_COLOR_SIGNATURE;
  // One source of truth for "which palette am I on", read by both the rail and
  // (through `roleColors` below) the verdict.
  const matchedPaletteId = matchingCvdPaletteId(overrides);
  const selectedPaletteCardId = selectedCvdPaletteCardId(matchedPaletteId, overrides);

  // Live board preview: the active board drawn with a real, well-known climb
  // that lights all four roles. The overlay colours/shapes come from the global
  // override store (BoardImageNative -> useNativeClimbRender) so every card on
  // the rail reflects edits live, in whichever render mode is active.
  const { preview: boardPreview } = useBoardPreviewClimb();

  // The verdict is computed from colours alone, so it stands whether or not
  // there is a board to draw — a climber with no board bound still gets the
  // answer, and so does anyone who cannot use the pictures.
  const roleColors = useMemo(
    () =>
      Object.fromEntries(
        HOLD_COLOR_OVERRIDE_ROLES.map((role) => [role, getEffectiveHoldRoleColor(boardName, role, overrides)]),
      ) as Record<HoldColorOverrideRole, string>,
    [boardName, overrides],
  );
  const verdict = useMemo(() => verdictLine(t, evaluateRoleSeparation(roleColors)), [roleColors, t]);

  const handleSaveRole = useCallback(
    (role: HoldColorOverrideRole, color: string | null, shape: HoldMarkerShape) => {
      setRoleMarkerOverride(role, color, shape);
      // The ONE manual colour edit in the app, so the one place the climber's own
      // colours get remembered. A palette apply deliberately does not mirror
      // here — it would overwrite the very colours this exists to hand back when
      // they press Custom.
      const nextColors: HoldColorOverrides = { ...overrides };
      if (color) {
        nextColors[role] = color;
      } else {
        delete nextColors[role];
      }
      void rememberCustomHoldColors(nextColors);
      setSelectedRole(null);
    },
    [overrides, setRoleMarkerOverride],
  );

  const handleSelectPalette = useCallback(
    (id: CvdPaletteOptionId) => {
      void applyCvdPaletteCard(id, { setRoleOverride, loadCustomColors: loadCustomHoldColors });
    },
    [setRoleOverride],
  );

  /** Starting over really starts over — the remembered colours go too. */
  const handleResetMarkers = useCallback(() => {
    resetOverrides();
    void clearCustomHoldColors();
  }, [resetOverrides]);

  return (
    <>
      <View style={styles.section}>
        <SectionHeader title={t('mobile.more.accessibility.cvd.title')} />
        <Text variant="footnote" color={systemColors.secondaryLabel} style={[styles.description, styles.sectionCopy]}>
          {t('mobile.more.accessibility.cvd.subtitle')}
        </Text>
        {/* The climber's own board, drawn once per palette. A picker, not a
            viewer: pressing a card writes the four role colours. */}
        {boardPreview ? (
          <PaletteCarousel preview={boardPreview} selectedId={selectedPaletteCardId} onSelect={handleSelectPalette} />
        ) : null}
        <View style={[styles.sectionCopy, styles.verdictBlock]}>
          {/* The rail above is five pictures, which is worth nothing to a blind
              climber and may be unreadable at 168pt to a low-vision one, so the
              answer is never only a picture. Stands whether or not there is a
              board to draw. */}
          {verdict ? (
            <Text variant="caption1" color={systemColors.secondaryLabel}>
              {verdict}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.more.boardLook.accessibility.title')} />
        <View style={[styles.card, styles.cardPadded, { backgroundColor: systemColors.secondaryBackground }]}>
          <SwitchRow
            label={t('mobile.more.boardLook.accessibility.roleGlyphs.label')}
            description={t('mobile.more.boardLook.accessibility.roleGlyphs.note')}
            value={boardsesh.roleGlyphs}
            onValueChange={(value) => setBoardseshField('roleGlyphs', value)}
          />
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.more.accessibility.markersTitle')} />
        {!isClassic ? (
          <Text
            variant="footnote"
            color={systemColors.secondaryLabel}
            style={[styles.description, styles.classicOnlyNote]}
          >
            {t('mobile.more.boardLook.accessibility.classicOnlyNote')}
          </Text>
        ) : null}
        <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
          {HOLD_COLOR_OVERRIDE_ROLES.map((role) => {
            const roleOverride = overrides[role];
            const roleShape = getEffectiveHoldRoleShape(role, shapes);
            const roleLabel = labelForRole(t, role);
            const modeLabel = roleOverride
              ? t('mobile.more.accessibility.mode.user')
              : t('mobile.more.accessibility.mode.default');
            const shapeLabel = labelForShape(t, roleShape);
            const subtitle = isClassic
              ? t('mobile.more.accessibility.rowSubtitle', { colorMode: modeLabel, shape: shapeLabel })
              : modeLabel;
            const swatchColor = getEffectiveHoldRoleColor(boardName, role, overrides);
            const hasRoleOverride = !!roleOverride || roleShape !== DEFAULT_HOLD_MARKER_SHAPE;
            return (
              <ListRow
                key={role}
                title={roleLabel}
                subtitle={subtitle}
                accessibilityLabel={t('mobile.more.accessibility.rowAccessibility', {
                  role: roleLabel,
                  mode: subtitle,
                })}
                leading={<MarkerSwatch color={swatchColor} shape={isClassic ? roleShape : 'circle'} size={shapeSize} />}
                trailing={
                  hasRoleOverride ? <Icon name="check.small" size={20} color={systemColors.accent} /> : undefined
                }
                showChevron
                showSeparator
                onPress={() => setSelectedRole(role)}
              />
            );
          })}
          {isClassic ? (
            <>
              <ListRow
                title={t('mobile.more.accessibility.brush.title')}
                subtitle={t('mobile.more.accessibility.brush.value', { value: brushThickness.toFixed(1) })}
                accessibilityLabel={t('mobile.more.accessibility.brush.rowAccessibility', {
                  value: brushThickness.toFixed(1),
                })}
                leading={
                  <MarkerSwatch
                    color={systemColors.accent}
                    shape="circle"
                    thickness={brushThickness}
                    size={shapeSize}
                  />
                }
                trailing={
                  brushThickness !== DEFAULT_HOLD_BRUSH_THICKNESS ? (
                    <Icon name="check.small" size={20} color={systemColors.accent} />
                  ) : undefined
                }
                showChevron
                showSeparator
                onPress={() => setThicknessSheetOpen(true)}
              />
              <ListRow
                title={t('mobile.more.accessibility.size.title')}
                subtitle={t('mobile.more.accessibility.size.value', { value: shapeSize.toFixed(1) })}
                accessibilityLabel={t('mobile.more.accessibility.size.rowAccessibility', {
                  value: shapeSize.toFixed(1),
                })}
                leading={<MarkerSwatch color={systemColors.accent} shape="diamond" size={shapeSize} />}
                trailing={
                  shapeSize !== DEFAULT_HOLD_SHAPE_SIZE ? (
                    <Icon name="check.small" size={20} color={systemColors.accent} />
                  ) : undefined
                }
                showChevron
                showSeparator={false}
                onPress={() => setSizeSheetOpen(true)}
              />
            </>
          ) : null}
        </View>
        {hasMarkerOverrides ? (
          <Pressable accessibilityRole="button" onPress={handleResetMarkers} style={styles.resetButton}>
            <Text variant="footnote" color={systemColors.accent}>
              {t('mobile.more.accessibility.resetAll')}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <HoldColorPickerSheet
        role={selectedRole}
        boardName={boardName}
        currentColor={selectedRole ? (overrides[selectedRole] ?? null) : null}
        currentShape={selectedRole ? getEffectiveHoldRoleShape(selectedRole, shapes) : DEFAULT_HOLD_MARKER_SHAPE}
        shapeSize={shapeSize}
        showShapePicker={isClassic}
        onSave={handleSaveRole}
        onClose={() => setSelectedRole(null)}
      />
      <BrushThicknessSheet
        open={thicknessSheetOpen}
        value={brushThickness}
        shapeSize={shapeSize}
        onSave={setBrushThickness}
        onClose={() => setThicknessSheetOpen(false)}
      />
      <ShapeSizeSheet
        open={sizeSheetOpen}
        value={shapeSize}
        brushThickness={brushThickness}
        onSave={setShapeSize}
        onClose={() => setSizeSheetOpen(false)}
      />
    </>
  );
}

type HoldColorPickerSheetProps = {
  role: HoldColorOverrideRole | null;
  boardName: BoardName;
  currentColor: string | null;
  currentShape: HoldMarkerShape;
  shapeSize: number;
  /** Classic only — Boardsesh draws the lit hold's own silhouette, so there's no shape to pick. */
  showShapePicker: boolean;
  onSave: (role: HoldColorOverrideRole, color: string | null, shape: HoldMarkerShape) => void;
  onClose: () => void;
};

function HoldColorPickerSheet({
  role,
  boardName,
  currentColor,
  currentShape,
  shapeSize,
  showShapePicker,
  onSave,
  onClose,
}: HoldColorPickerSheetProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const [mode, setMode] = useState<ColorMode>('default');
  const [userColor, setUserColor] = useState<string>('#00ff00');
  const [shape, setShape] = useState<HoldMarkerShape>(DEFAULT_HOLD_MARKER_SHAPE);
  const [seedCounter, setSeedCounter] = useState(0);
  // Tracks the closed->open transition so the fields re-seed each time the picker
  // opens; the ModalSheet is driven declaratively off `role != null`.
  const wasOpenRef = useRef(false);

  const modeOptions = useMemo<{ key: ColorMode; label: string }[]>(
    () => [
      { key: 'default', label: t('mobile.more.accessibility.mode.default') },
      { key: 'user', label: t('mobile.more.accessibility.mode.user') },
    ],
    [t],
  );

  useEffect(() => {
    if (role != null && !wasOpenRef.current) {
      const seedColor = currentColor ?? getDefaultHoldRoleColor(boardName, role, 'led');
      setMode(currentColor ? 'user' : 'default');
      setUserColor(seedColor);
      setShape(currentShape);
      setSeedCounter((value) => value + 1);
    }
    wasOpenRef.current = role != null;
  }, [boardName, currentColor, currentShape, role]);

  const previewColor = mode === 'user' ? userColor : role ? getDefaultHoldRoleColor(boardName, role) : '#000000';

  const handleModeSelect = useCallback(
    (nextMode: ColorMode) => {
      setMode(nextMode);
      if (nextMode === 'user' && role) {
        setUserColor(currentColor ?? getDefaultHoldRoleColor(boardName, role, 'led'));
        setSeedCounter((value) => value + 1);
      }
    },
    [boardName, currentColor, role],
  );

  const handleSave = useCallback(() => {
    if (!role) return;
    onSave(role, mode === 'default' ? null : userColor, shape);
  }, [mode, onSave, role, shape, userColor]);

  const footer = <Button title={t('mobile.more.accessibility.save')} onPress={handleSave} size="large" />;

  return (
    <ModalSheet visible={role != null} snapPoints={['95%']} onClose={onClose} footer={footer} scrollable>
      <View style={styles.pickerBody}>
        <View style={styles.pickerHeader}>
          <MarkerSwatch color={previewColor} shape={shape} size={shapeSize} />
          <View style={styles.pickerTitleColumn}>
            <Text variant="headline">{role ? labelForRole(t, role) : t('mobile.more.accessibility.title')}</Text>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {t('mobile.more.accessibility.pickerSubtitle')}
            </Text>
          </View>
        </View>

        <SegmentedControl
          options={modeOptions}
          selectedKey={mode}
          onSelect={handleModeSelect}
          trackColor={systemColors.fill}
          accessibilityLabel={t('mobile.more.accessibility.modeLabel')}
        />

        {mode === 'user' ? (
          <OkhslColorPicker key={seedCounter} value={userColor} onChange={setUserColor} />
        ) : (
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.defaultCopy}>
            {t('mobile.more.accessibility.defaultCopy')}
          </Text>
        )}

        {showShapePicker ? (
          <View style={styles.shapeSection}>
            <Text variant="subheadline" color={systemColors.label}>
              {t('mobile.more.accessibility.shapeLabel')}
            </Text>
            <View style={styles.shapeGrid}>
              {HOLD_MARKER_SHAPES.map((option) => {
                const selected = shape === option;
                return (
                  <Pressable
                    key={option}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={labelForShape(t, option)}
                    onPress={() => setShape(option)}
                    style={[
                      styles.shapeButton,
                      {
                        backgroundColor: systemColors.fill,
                        borderColor: selected ? systemColors.accent : systemColors.separator,
                      },
                      selected && styles.shapeButtonSelected,
                    ]}
                  >
                    <MarkerSwatch color={previewColor} shape={option} size={shapeSize} />
                    <Text variant="caption1" color={systemColors.label} style={styles.shapeLabel} numberOfLines={2}>
                      {labelForShape(t, option)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}
      </View>
    </ModalSheet>
  );
}

type BrushThicknessSheetProps = {
  open: boolean;
  value: number;
  shapeSize: number;
  onSave: (brushThickness: number) => void;
  onClose: () => void;
};

function BrushThicknessSheet({ open, value, shapeSize, onSave, onClose }: BrushThicknessSheetProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  // Tracks the closed->open transition so the draft re-seeds each time the sheet
  // opens; the ModalSheet is driven declaratively off `open`.
  const wasOpenRef = useRef(false);
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setDraftValue(value);
    }
    wasOpenRef.current = open;
  }, [open, value]);

  const handleSave = useCallback(() => {
    onSave(draftValue);
    onClose();
  }, [draftValue, onClose, onSave]);

  const footer = <Button title={t('mobile.more.accessibility.brush.save')} onPress={handleSave} size="large" />;

  return (
    <ModalSheet visible={open} snapPoints={['48%', '80%']} onClose={onClose} footer={footer} scrollable>
      <View style={styles.pickerBody}>
        <View style={styles.pickerHeader}>
          <MarkerSwatch color={systemColors.accent} shape="circle" thickness={draftValue} size={shapeSize} />
          <View style={styles.pickerTitleColumn}>
            <Text variant="headline">{t('mobile.more.accessibility.brush.title')}</Text>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {t('mobile.more.accessibility.brush.subtitle')}
            </Text>
          </View>
        </View>
        <MarkerMultiplierSlider
          accessibilityLabel={t('mobile.more.accessibility.brush.title')}
          value={draftValue}
          min={MIN_HOLD_BRUSH_THICKNESS}
          max={MAX_HOLD_BRUSH_THICKNESS}
          step={0.1}
          format={(multiplier) =>
            t('mobile.more.accessibility.brush.value', { value: normalizeBrushThickness(multiplier).toFixed(1) })
          }
          onChange={setDraftValue}
        />
      </View>
    </ModalSheet>
  );
}

type ShapeSizeSheetProps = {
  open: boolean;
  value: number;
  brushThickness: number;
  onSave: (shapeSize: number) => void;
  onClose: () => void;
};

function ShapeSizeSheet({ open, value, brushThickness, onSave, onClose }: ShapeSizeSheetProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  // Tracks the closed->open transition so the draft re-seeds each time the sheet
  // opens; the ModalSheet is driven declaratively off `open`.
  const wasOpenRef = useRef(false);
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setDraftValue(value);
    }
    wasOpenRef.current = open;
  }, [open, value]);

  const handleSave = useCallback(() => {
    onSave(draftValue);
    onClose();
  }, [draftValue, onClose, onSave]);

  const footer = <Button title={t('mobile.more.accessibility.size.save')} onPress={handleSave} size="large" />;

  return (
    <ModalSheet visible={open} snapPoints={['48%', '80%']} onClose={onClose} footer={footer} scrollable>
      <View style={styles.pickerBody}>
        <View style={styles.pickerHeader}>
          <MarkerSwatch color={systemColors.accent} shape="diamond" thickness={brushThickness} size={draftValue} />
          <View style={styles.pickerTitleColumn}>
            <Text variant="headline">{t('mobile.more.accessibility.size.title')}</Text>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {t('mobile.more.accessibility.size.subtitle')}
            </Text>
          </View>
        </View>
        <MarkerMultiplierSlider
          accessibilityLabel={t('mobile.more.accessibility.size.title')}
          value={draftValue}
          min={MIN_HOLD_SHAPE_SIZE}
          max={MAX_HOLD_SHAPE_SIZE}
          step={0.1}
          format={(multiplier) =>
            t('mobile.more.accessibility.size.value', { value: normalizeHoldShapeSize(multiplier).toFixed(1) })
          }
          onChange={setDraftValue}
        />
      </View>
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing[2],
  },
  description: {
    lineHeight: 18,
  },
  classicOnlyNote: {
    paddingHorizontal: spacing[4],
  },
  sectionCopy: {
    paddingHorizontal: spacing[4],
  },
  verdictBlock: {
    gap: spacing[1],
  },
  card: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    marginHorizontal: spacing[4],
  },
  cardPadded: {
    padding: spacing[3],
    gap: spacing[3],
  },
  resetButton: {
    alignSelf: 'flex-start',
    paddingVertical: spacing[1],
    paddingHorizontal: spacing[4],
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickerBody: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    gap: spacing[4],
  },
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  pickerTitleColumn: {
    flex: 1,
    gap: spacing[1],
  },
  defaultCopy: {
    lineHeight: 18,
  },
  shapeSection: {
    gap: spacing[2],
  },
  shapeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
  shapeButton: {
    width: '31%',
    minHeight: 86,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    padding: spacing[2],
  },
  shapeButtonSelected: {
    borderWidth: 2,
  },
  shapeLabel: {
    textAlign: 'center',
  },
});
