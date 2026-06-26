import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type ColorValue,
  type GestureResponderEvent,
} from 'react-native';
import { BottomSheetModal } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toBoardName } from '@boardsesh/board-config';
import type { BoardName, ClimbSearchInput } from '@boardsesh/shared-schema';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { ListRow } from '../ListRow';
import { ModalSheet } from '../ModalSheet';
import { SectionHeader } from '../SectionHeader';
import { SegmentedControl } from '../SegmentedControl';
import { Text } from '../Text';
import { BoardImageNative } from '../BoardImageNative';
import { HoldMarkerShapeSvg } from '../board-renderer/HoldMarkerShape';
import { useTheme } from '../../providers/theme-provider';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useInfiniteSearchClimbs } from '../../lib/graphql/hooks/use-infinite-search-climbs';
import { getBoardRenderData } from '../../lib/board-details';
import { simulateCvd, type CvdType } from '../../lib/cvd-simulation';
import { OkhslColorPicker } from './OkhslColorPicker';
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
  hasHoldMarkerOverrides,
  normalizeBrushThickness,
  normalizeHoldShapeSize,
  useHoldColorOverrides,
  type HoldColorOverrideRole,
  type HoldMarkerShape,
} from '../../lib/hold-color-overrides';
import { borderRadius, spacing } from '../../theme/tokens';

type ColorMode = 'default' | 'user';
type CvdMode = 'none' | CvdType;

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

function applyCvd(color: string, mode: CvdMode): string {
  return mode === 'none' ? color : simulateCvd(color, mode);
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

export function AccessibilitySettingsScreen() {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const { scrollBottomPadding } = useBottomChromeMetrics();
  const { data: activeBoard } = useActiveBoard();
  const boardName = boardNameFromActiveBoard(activeBoard?.boardType);
  const {
    overrides,
    markerOverrides,
    shapes,
    brushThickness,
    shapeSize,
    setRoleMarkerOverride,
    setBrushThickness,
    setShapeSize,
    resetOverrides,
    renderSignature,
  } = useHoldColorOverrides();
  const [selectedRole, setSelectedRole] = useState<HoldColorOverrideRole | null>(null);
  const [thicknessSheetOpen, setThicknessSheetOpen] = useState(false);
  const [sizeSheetOpen, setSizeSheetOpen] = useState(false);
  const [cvdMode, setCvdMode] = useState<CvdMode>('none');
  const hasOverrides = renderSignature !== DEFAULT_HOLD_COLOR_SIGNATURE && hasHoldMarkerOverrides(markerOverrides);

  const cvdOptions = useMemo<{ key: CvdMode; label: string }[]>(
    () => [
      { key: 'none', label: t('mobile.more.accessibility.cvd.none') },
      { key: 'deuteranopia', label: t('mobile.more.accessibility.cvd.deuteranopiaShort') },
      { key: 'protanopia', label: t('mobile.more.accessibility.cvd.protanopiaShort') },
      { key: 'tritanopia', label: t('mobile.more.accessibility.cvd.tritanopiaShort') },
    ],
    [t],
  );

  // Live board preview: render the active board with a real, well-known climb —
  // the most-climbed boulder for this exact layout/size/set/angle (so hold IDs
  // line up), which naturally lights all four roles. The overlay colours/shapes
  // come from the global override store (BoardImageNative → useNativeClimbRender)
  // so the preview reflects edits live. The board photo can't be CVD-simulated,
  // so the simulation toggle drives the compare strip below instead.
  const climbSearchInput = useMemo<ClimbSearchInput>(
    () => ({
      boardName,
      layoutId: activeBoard?.layoutId ?? 0,
      sizeId: activeBoard?.sizeId ?? 0,
      setIds: activeBoard?.setIds ?? '',
      angle: activeBoard?.angle ?? 40,
      sortBy: 'ascents',
      sortOrder: 'desc',
      pageSize: 1,
    }),
    [activeBoard, boardName],
  );
  const { data: exampleClimbData } = useInfiniteSearchClimbs(climbSearchInput, !!activeBoard, {
    staleTime: 60 * 60 * 1000,
  });
  const exampleClimbFrames = exampleClimbData?.pages?.[0]?.climbs?.[0]?.frames ?? null;

  const boardPreview = useMemo(() => {
    if (!activeBoard || !exampleClimbFrames) return null;
    const renderData = getBoardRenderData({
      boardName,
      layoutId: activeBoard.layoutId,
      sizeId: activeBoard.sizeId,
      setIds: activeBoard.setIds.split(',').map(Number).filter(Boolean),
    });
    if (!renderData) return null;
    return {
      frames: exampleClimbFrames,
      layoutId: activeBoard.layoutId,
      sizeId: activeBoard.sizeId,
      setIds: activeBoard.setIds,
      boardWidth: renderData.boardWidth,
      boardHeight: renderData.boardHeight,
    };
  }, [activeBoard, boardName, exampleClimbFrames]);

  const handleSaveRole = useCallback(
    (role: HoldColorOverrideRole, color: string | null, shape: HoldMarkerShape) => {
      setRoleMarkerOverride(role, color, shape);
      setSelectedRole(null);
    },
    [setRoleMarkerOverride],
  );

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.scrollContent, { paddingBottom: scrollBottomPadding + spacing[4] }]}
    >
      <View style={styles.intro}>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.description}>
          {t('mobile.more.accessibility.description')}
        </Text>
      </View>

      {boardPreview ? (
        <View style={styles.previewSection}>
          <SectionHeader title={t('mobile.more.accessibility.preview.title')} />
          <View style={[styles.previewCard, { backgroundColor: systemColors.secondaryBackground }]}>
            <BoardImageNative
              frames={boardPreview.frames}
              boardName={boardName}
              layoutId={boardPreview.layoutId}
              sizeId={boardPreview.sizeId}
              setIds={boardPreview.setIds}
              boardWidth={boardPreview.boardWidth}
              boardHeight={boardPreview.boardHeight}
              renderWidth={600}
              style={styles.previewBoard}
            />
            <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.previewCaption}>
              {t('mobile.more.accessibility.preview.caption')}
            </Text>
          </View>
        </View>
      ) : null}

      <View style={styles.section}>
        <SectionHeader title={t('mobile.more.accessibility.cvd.title')} />
        <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
          <View style={styles.cardPadded}>
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.description}>
              {t('mobile.more.accessibility.cvd.subtitle')}
            </Text>
            <SegmentedControl
              options={cvdOptions}
              selectedKey={cvdMode}
              onSelect={setCvdMode}
              trackColor={systemColors.fill}
              accessibilityLabel={t('mobile.more.accessibility.cvd.title')}
            />
            <View style={styles.roleStrip} accessibilityLabel={t('mobile.more.accessibility.compare.accessibility')}>
              {HOLD_COLOR_OVERRIDE_ROLES.map((role) => {
                const swatchColor = applyCvd(getEffectiveHoldRoleColor(boardName, role, overrides), cvdMode);
                const roleShape = getEffectiveHoldRoleShape(role, shapes);
                return (
                  <View key={role} style={styles.roleStripItem}>
                    <MarkerSwatch color={swatchColor} shape={roleShape} size={shapeSize} thickness={brushThickness} />
                    <Text variant="caption2" color={systemColors.secondaryLabel} numberOfLines={1}>
                      {labelForRole(t, role)}
                    </Text>
                  </View>
                );
              })}
            </View>
            <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.description}>
              {t('mobile.more.accessibility.cvd.compareHint')}
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('mobile.more.accessibility.markersTitle')} />
        <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
          {HOLD_COLOR_OVERRIDE_ROLES.map((role) => {
            const roleOverride = overrides[role];
            const roleShape = getEffectiveHoldRoleShape(role, shapes);
            const roleLabel = labelForRole(t, role);
            const modeLabel = roleOverride
              ? t('mobile.more.accessibility.mode.user')
              : t('mobile.more.accessibility.mode.default');
            const shapeLabel = labelForShape(t, roleShape);
            const subtitle = t('mobile.more.accessibility.rowSubtitle', { colorMode: modeLabel, shape: shapeLabel });
            const swatchColor = applyCvd(getEffectiveHoldRoleColor(boardName, role, overrides), cvdMode);
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
                leading={<MarkerSwatch color={swatchColor} shape={roleShape} size={shapeSize} />}
                trailing={
                  hasRoleOverride ? <Icon name="check.small" size={20} color={systemColors.accent} /> : undefined
                }
                showChevron
                showSeparator
                onPress={() => setSelectedRole(role)}
              />
            );
          })}
          <ListRow
            title={t('mobile.more.accessibility.brush.title')}
            subtitle={t('mobile.more.accessibility.brush.value', { value: brushThickness.toFixed(1) })}
            accessibilityLabel={t('mobile.more.accessibility.brush.rowAccessibility', {
              value: brushThickness.toFixed(1),
            })}
            leading={
              <MarkerSwatch color={systemColors.accent} shape="circle" thickness={brushThickness} size={shapeSize} />
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
        </View>
        {hasOverrides ? (
          <Pressable accessibilityRole="button" onPress={resetOverrides} style={styles.resetButton}>
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
    </ScrollView>
  );
}

type HoldColorPickerSheetProps = {
  role: HoldColorOverrideRole | null;
  boardName: BoardName;
  currentColor: string | null;
  currentShape: HoldMarkerShape;
  shapeSize: number;
  onSave: (role: HoldColorOverrideRole, color: string | null, shape: HoldMarkerShape) => void;
  onClose: () => void;
};

function HoldColorPickerSheet({
  role,
  boardName,
  currentColor,
  currentShape,
  shapeSize,
  onSave,
  onClose,
}: HoldColorPickerSheetProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const sheetRef = useRef<BottomSheetModal>(null);
  const [mode, setMode] = useState<ColorMode>('default');
  const [userColor, setUserColor] = useState<string>('#00ff00');
  const [shape, setShape] = useState<HoldMarkerShape>(DEFAULT_HOLD_MARKER_SHAPE);
  const [seedCounter, setSeedCounter] = useState(0);
  const isPresentedRef = useRef(false);

  const modeOptions = useMemo<{ key: ColorMode; label: string }[]>(
    () => [
      { key: 'default', label: t('mobile.more.accessibility.mode.default') },
      { key: 'user', label: t('mobile.more.accessibility.mode.user') },
    ],
    [t],
  );

  useEffect(() => {
    if (role && !isPresentedRef.current) {
      const seedColor = currentColor ?? getDefaultHoldRoleColor(boardName, role, 'led');
      setMode(currentColor ? 'user' : 'default');
      setUserColor(seedColor);
      setShape(currentShape);
      setSeedCounter((value) => value + 1);
      sheetRef.current?.present();
      isPresentedRef.current = true;
    } else if (!role && isPresentedRef.current) {
      sheetRef.current?.dismiss();
      isPresentedRef.current = false;
    }
  }, [boardName, currentColor, currentShape, role]);

  const previewColor = mode === 'user' ? userColor : role ? getDefaultHoldRoleColor(boardName, role) : '#000000';

  const handleDismiss = useCallback(() => {
    isPresentedRef.current = false;
    onClose();
  }, [onClose]);

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
    <ModalSheet
      ref={sheetRef}
      snapPoints={['95%']}
      onDismiss={handleDismiss}
      footer={footer}
      stackBehavior="push"
      scrollable
    >
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
          <OkhslColorPicker value={userColor} onChange={setUserColor} seedKey={seedCounter} />
        ) : (
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.defaultCopy}>
            {t('mobile.more.accessibility.defaultCopy')}
          </Text>
        )}

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
  const sheetRef = useRef<BottomSheetModal>(null);
  const isPresentedRef = useRef(false);
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    if (open && !isPresentedRef.current) {
      setDraftValue(value);
      sheetRef.current?.present();
      isPresentedRef.current = true;
    } else if (!open && isPresentedRef.current) {
      sheetRef.current?.dismiss();
      isPresentedRef.current = false;
    }
  }, [open, value]);

  const handleDismiss = useCallback(() => {
    isPresentedRef.current = false;
    onClose();
  }, [onClose]);

  const handleSave = useCallback(() => {
    onSave(draftValue);
    onClose();
  }, [draftValue, onClose, onSave]);

  const footer = <Button title={t('mobile.more.accessibility.brush.save')} onPress={handleSave} size="large" />;

  return (
    <ModalSheet
      ref={sheetRef}
      snapPoints={['48%', '80%']}
      onDismiss={handleDismiss}
      footer={footer}
      stackBehavior="push"
      scrollable
    >
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
          valueText={t('mobile.more.accessibility.brush.value', { value: draftValue.toFixed(1) })}
          min={MIN_HOLD_BRUSH_THICKNESS}
          max={MAX_HOLD_BRUSH_THICKNESS}
          normalizeValue={normalizeBrushThickness}
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
  const sheetRef = useRef<BottomSheetModal>(null);
  const isPresentedRef = useRef(false);
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    if (open && !isPresentedRef.current) {
      setDraftValue(value);
      sheetRef.current?.present();
      isPresentedRef.current = true;
    } else if (!open && isPresentedRef.current) {
      sheetRef.current?.dismiss();
      isPresentedRef.current = false;
    }
  }, [open, value]);

  const handleDismiss = useCallback(() => {
    isPresentedRef.current = false;
    onClose();
  }, [onClose]);

  const handleSave = useCallback(() => {
    onSave(draftValue);
    onClose();
  }, [draftValue, onClose, onSave]);

  const footer = <Button title={t('mobile.more.accessibility.size.save')} onPress={handleSave} size="large" />;

  return (
    <ModalSheet
      ref={sheetRef}
      snapPoints={['48%', '80%']}
      onDismiss={handleDismiss}
      footer={footer}
      stackBehavior="push"
      scrollable
    >
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
          valueText={t('mobile.more.accessibility.size.value', { value: draftValue.toFixed(1) })}
          min={MIN_HOLD_SHAPE_SIZE}
          max={MAX_HOLD_SHAPE_SIZE}
          normalizeValue={normalizeHoldShapeSize}
          onChange={setDraftValue}
        />
      </View>
    </ModalSheet>
  );
}

function MarkerMultiplierSlider({
  accessibilityLabel,
  value,
  valueText,
  min,
  max,
  normalizeValue,
  onChange,
}: {
  accessibilityLabel: string;
  value: number;
  valueText: string;
  min: number;
  max: number;
  normalizeValue: (value: unknown) => number;
  onChange: (multiplier: number) => void;
}) {
  const { systemColors } = useTheme();
  const trackRef = useRef<View>(null);
  const trackLayoutRef = useRef<{ pageLeft: number; width: number } | null>(null);
  const ratio = (value - min) / (max - min);

  const applyPageX = useCallback(
    (pageX: number, trackLayout: { pageLeft: number; width: number }) => {
      if (trackLayout.width <= 0) return;
      const nextRatio = Math.max(0, Math.min(1, (pageX - trackLayout.pageLeft) / trackLayout.width));
      const nextValue = min + nextRatio * (max - min);
      onChange(normalizeValue(nextValue));
    },
    [max, min, normalizeValue, onChange],
  );

  const measureTrackAndSetFromPageX = useCallback(
    (pageX: number) => {
      trackRef.current?.measure((_x, _y, width, _height, pageLeft) => {
        if (width <= 0) return;
        const trackLayout = { pageLeft, width };
        trackLayoutRef.current = trackLayout;
        applyPageX(pageX, trackLayout);
      });
    },
    [applyPageX],
  );

  const setFromPageX = useCallback(
    (pageX: number) => {
      const trackLayout = trackLayoutRef.current;
      if (trackLayout) {
        applyPageX(pageX, trackLayout);
        return;
      }
      measureTrackAndSetFromPageX(pageX);
    },
    [applyPageX, measureTrackAndSetFromPageX],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event: GestureResponderEvent) => measureTrackAndSetFromPageX(event.nativeEvent.pageX),
        onPanResponderMove: (_event, gestureState) => setFromPageX(gestureState.moveX),
      }),
    [measureTrackAndSetFromPageX, setFromPageX],
  );

  const handleAccessibilityAction = useCallback(
    (event: { nativeEvent: { actionName: string } }) => {
      const delta = event.nativeEvent.actionName === 'increment' ? 0.1 : -0.1;
      onChange(normalizeValue(value + delta));
    },
    [normalizeValue, onChange, value],
  );

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: valueText }}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={handleAccessibilityAction}
      style={styles.sliderContainer}
      {...panResponder.panHandlers}
    >
      <View style={styles.sliderLabels}>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {min.toFixed(1)}
        </Text>
        <Text variant="headline">{valueText}</Text>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {max.toFixed(1)}
        </Text>
      </View>
      <View
        ref={trackRef}
        onLayout={() => {
          trackLayoutRef.current = null;
        }}
        style={[styles.sliderTrack, { backgroundColor: systemColors.separator }]}
      >
        <View
          style={[
            styles.sliderFill,
            {
              backgroundColor: systemColors.accent,
              width: `${Math.max(0, Math.min(1, ratio)) * 100}%`,
            },
          ]}
        />
        <View
          style={[
            styles.sliderThumb,
            {
              backgroundColor: systemColors.background,
              borderColor: systemColors.accent,
              left: `${Math.max(0, Math.min(1, ratio)) * 100}%`,
            },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    flexGrow: 1,
    paddingTop: spacing[4],
    gap: spacing[6],
  },
  intro: {
    paddingHorizontal: spacing[4],
  },
  description: {
    lineHeight: 18,
  },
  previewSection: {
    gap: spacing[2],
  },
  previewCard: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    marginHorizontal: spacing[4],
    padding: spacing[3],
    gap: spacing[2],
  },
  previewBoard: {
    borderRadius: borderRadius.md,
    overflow: 'hidden',
  },
  previewCaption: {
    lineHeight: 16,
  },
  section: {
    gap: spacing[2],
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
  roleStrip: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'flex-start',
    gap: spacing[2],
  },
  roleStripItem: {
    alignItems: 'center',
    gap: spacing[1],
    flex: 1,
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
  sliderContainer: {
    gap: spacing[3],
    paddingVertical: spacing[2],
  },
  sliderLabels: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[2],
  },
  sliderTrack: {
    height: 6,
    borderRadius: 3,
  },
  sliderFill: {
    height: 6,
    borderRadius: 3,
  },
  sliderThumb: {
    position: 'absolute',
    top: -9,
    width: 24,
    height: 24,
    marginLeft: -12,
    borderRadius: 12,
    borderWidth: 2,
  },
});

const accessibilityActions = [{ name: 'increment' }, { name: 'decrement' }] as const;
