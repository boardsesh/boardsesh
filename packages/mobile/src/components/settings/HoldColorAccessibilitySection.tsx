import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  type ColorValue,
  type GestureResponderEvent,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { BottomSheetModal, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toBoardName } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/shared-schema';
import Svg, { Circle, Polygon, Rect } from 'react-native-svg';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { ListRow } from '../ListRow';
import { ModalSheet } from '../ModalSheet';
import { SectionHeader } from '../SectionHeader';
import { SegmentedControl } from '../SegmentedControl';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
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
  hexToRgb,
  normalizeHexColor,
  normalizeBrushThickness,
  normalizeHoldShapeSize,
  parseRgbChannel,
  rgbToHex,
  useHoldColorOverrides,
  type HoldColorOverrideRole,
  type HoldMarkerShape,
  type RgbColor,
} from '../../lib/hold-color-overrides';
import { borderRadius, spacing } from '../../theme/tokens';

type ColorMode = 'default' | 'user';

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
  }
}

function rgbTextFromHex(color: string): RgbColorText {
  const rgb = hexToRgb(color) ?? { red: 0, green: 0, blue: 0 };
  return {
    red: String(rgb.red),
    green: String(rgb.green),
    blue: String(rgb.blue),
  };
}

type RgbColorText = {
  red: string;
  green: string;
  blue: string;
};

function rgbFromText(rgbText: RgbColorText): RgbColor | null {
  const red = parseRgbChannel(rgbText.red);
  const green = parseRgbChannel(rgbText.green);
  const blue = parseRgbChannel(rgbText.blue);
  if (red === null || green === null || blue === null) return null;
  return { red, green, blue };
}

function boardNameFromActiveBoard(boardType: string | undefined): BoardName {
  return toBoardName(boardType) ?? 'kilter';
}

export function HoldColorAccessibilitySection() {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
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
  const hasOverrides = renderSignature !== DEFAULT_HOLD_COLOR_SIGNATURE && hasHoldMarkerOverrides(markerOverrides);

  const handleSaveRole = useCallback(
    (role: HoldColorOverrideRole, color: string | null, shape: HoldMarkerShape) => {
      setRoleMarkerOverride(role, color, shape);
      setSelectedRole(null);
    },
    [setRoleMarkerOverride],
  );

  return (
    <View style={styles.section}>
      <SectionHeader title={t('mobile.more.accessibility.title')} />
      <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
        <View style={styles.header}>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.description}>
            {t('mobile.more.accessibility.description')}
          </Text>
          {hasOverrides ? (
            <Pressable accessibilityRole="button" onPress={resetOverrides} style={styles.resetButton}>
              <Text variant="footnote" color={systemColors.accent}>
                {t('mobile.more.accessibility.resetAll')}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {HOLD_COLOR_OVERRIDE_ROLES.map((role, index) => {
          const roleOverride = overrides[role];
          const roleShape = getEffectiveHoldRoleShape(role, shapes);
          const roleLabel = labelForRole(t, role);
          const modeLabel = roleOverride
            ? t('mobile.more.accessibility.mode.user')
            : t('mobile.more.accessibility.mode.default');
          const shapeLabel = labelForShape(t, roleShape);
          const subtitle = t('mobile.more.accessibility.rowSubtitle', { colorMode: modeLabel, shape: shapeLabel });
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
              leading={<MarkerSwatch color={swatchColor} shape={roleShape} size={shapeSize} />}
              trailing={hasRoleOverride ? <Icon name="check.small" size={20} color={systemColors.accent} /> : undefined}
              showChevron
              showSeparator={index < HOLD_COLOR_OVERRIDE_ROLES.length}
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
    </View>
  );
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
  const center = 21;
  const radius = 9 * shapeSize;
  const triangleUpPoints = `${center},${center - radius} ${center + radius * 0.866},${center + radius * 0.5} ${
    center - radius * 0.866
  },${center + radius * 0.5}`;
  const triangleDownPoints = `${center - radius * 0.866},${center - radius * 0.5} ${center + radius * 0.866},${
    center - radius * 0.5
  } ${center},${center + radius}`;
  const squareHalfSide = radius * 0.82;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.swatch, { borderColor: systemColors.separator }]}
    >
      <Svg width="30" height="30" viewBox="0 0 42 42">
        {shape === 'circle' ? (
          <Circle
            cx={center}
            cy={center}
            r={radius}
            fill={color}
            fillOpacity={0.25}
            stroke={color}
            strokeWidth={strokeWidth}
          />
        ) : null}
        {shape === 'triangle-up' ? (
          <Polygon
            points={triangleUpPoints}
            fill={color}
            fillOpacity={0.25}
            stroke={color}
            strokeLinejoin="round"
            strokeWidth={strokeWidth}
          />
        ) : null}
        {shape === 'triangle-down' ? (
          <Polygon
            points={triangleDownPoints}
            fill={color}
            fillOpacity={0.25}
            stroke={color}
            strokeLinejoin="round"
            strokeWidth={strokeWidth}
          />
        ) : null}
        {shape === 'square' ? (
          <Rect
            x={center - squareHalfSide}
            y={center - squareHalfSide}
            width={squareHalfSide * 2}
            height={squareHalfSide * 2}
            fill={color}
            fillOpacity={0.25}
            stroke={color}
            strokeLinejoin="round"
            strokeWidth={strokeWidth}
          />
        ) : null}
        {shape === 'diamond' ? (
          <Polygon
            points={`${center},${center - radius} ${center + radius},${center} ${center},${center + radius} ${
              center - radius
            },${center}`}
            fill={color}
            fillOpacity={0.25}
            stroke={color}
            strokeLinejoin="round"
            strokeWidth={strokeWidth}
          />
        ) : null}
      </Svg>
    </View>
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
  const [rgbText, setRgbText] = useState<RgbColorText>({ red: '0', green: '0', blue: '0' });
  const [shape, setShape] = useState<HoldMarkerShape>(DEFAULT_HOLD_MARKER_SHAPE);
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
      setRgbText(rgbTextFromHex(seedColor));
      setShape(currentShape);
      sheetRef.current?.present();
      isPresentedRef.current = true;
    } else if (!role && isPresentedRef.current) {
      sheetRef.current?.dismiss();
      isPresentedRef.current = false;
    }
  }, [boardName, currentColor, currentShape, role]);

  const resolvedRgb = mode === 'user' ? rgbFromText(rgbText) : null;
  const resolvedHex = resolvedRgb ? rgbToHex(resolvedRgb) : null;
  const previewColor =
    mode === 'user' && resolvedHex && role ? resolvedHex : role ? getDefaultHoldRoleColor(boardName, role) : '#000000';
  const showValidationError = mode === 'user' && resolvedHex === null;

  const handleDismiss = useCallback(() => {
    isPresentedRef.current = false;
    onClose();
  }, [onClose]);

  const handleModeSelect = useCallback(
    (nextMode: ColorMode) => {
      setMode(nextMode);
      if (nextMode === 'user' && role) {
        const seedColor = currentColor ?? getDefaultHoldRoleColor(boardName, role, 'led');
        const normalizedSeed = normalizeHexColor(seedColor);
        if (normalizedSeed) setRgbText(rgbTextFromHex(normalizedSeed));
      }
    },
    [boardName, currentColor, role],
  );

  const handleSave = useCallback(() => {
    if (!role) return;
    if (mode === 'default') {
      onSave(role, null, shape);
      return;
    }
    if (!resolvedHex) return;
    onSave(role, resolvedHex, shape);
  }, [mode, onSave, resolvedHex, role, shape]);

  const footer = (
    <Button
      title={t('mobile.more.accessibility.save')}
      onPress={handleSave}
      disabled={mode === 'user' && resolvedHex === null}
      size="large"
    />
  );

  const inputStyle = [
    styles.channelInput,
    {
      backgroundColor: systemColors.fill,
      color: systemColors.label,
      borderColor: showValidationError ? systemColors.accent : systemColors.separator,
    },
  ];

  return (
    <ModalSheet
      ref={sheetRef}
      snapPoints={['82%', '94%']}
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
          <View style={styles.rgbGrid}>
            <RgbChannelInput
              label={t('mobile.more.accessibility.channels.red')}
              value={rgbText.red}
              onChangeText={(red) => setRgbText((previous) => ({ ...previous, red }))}
              inputStyle={inputStyle}
              invalid={showValidationError}
            />
            <RgbChannelInput
              label={t('mobile.more.accessibility.channels.green')}
              value={rgbText.green}
              onChangeText={(green) => setRgbText((previous) => ({ ...previous, green }))}
              inputStyle={inputStyle}
              invalid={showValidationError}
            />
            <RgbChannelInput
              label={t('mobile.more.accessibility.channels.blue')}
              value={rgbText.blue}
              onChangeText={(blue) => setRgbText((previous) => ({ ...previous, blue }))}
              inputStyle={inputStyle}
              invalid={showValidationError}
            />
          </View>
        ) : (
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.defaultCopy}>
            {t('mobile.more.accessibility.defaultCopy')}
          </Text>
        )}

        {showValidationError ? (
          <Text variant="footnote" color={systemColors.accent}>
            {t('mobile.more.accessibility.invalidRgb')}
          </Text>
        ) : null}

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

function RgbChannelInput({
  label,
  value,
  onChangeText,
  inputStyle,
  invalid,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  inputStyle: StyleProp<TextStyle>;
  invalid: boolean;
}) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  return (
    <View style={styles.channelColumn}>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.channelLabel}>
        {label}
      </Text>
      <BottomSheetTextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType="number-pad"
        maxLength={3}
        selectTextOnFocus
        returnKeyType="done"
        accessibilityLabel={label}
        accessibilityHint={invalid ? t('mobile.more.accessibility.invalidRgb') : undefined}
        style={inputStyle}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing[2],
  },
  card: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
  },
  header: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    paddingBottom: spacing[2],
    gap: spacing[2],
  },
  description: {
    lineHeight: 18,
  },
  resetButton: {
    alignSelf: 'flex-start',
    paddingVertical: spacing[1],
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
  rgbGrid: {
    flexDirection: 'row',
    gap: spacing[3],
  },
  channelColumn: {
    flex: 1,
    gap: spacing[1],
  },
  channelLabel: {
    textAlign: 'center',
  },
  channelInput: {
    minHeight: 46,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing[3],
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '600',
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
