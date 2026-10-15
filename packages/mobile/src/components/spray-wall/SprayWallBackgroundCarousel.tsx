import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PressableSurface } from '../PressableSurface';
import { SnapCarousel } from '../SnapCarousel';
import { Text } from '../Text';
import { RailIndexDots } from '../board-look/RailIndexDots';
import { RAIL_MIN_WIDTH } from '../board-look/board-look-card-metrics';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import type { SprayWallBackground } from '../../lib/spray/spray-wall-background';
import type { SprayLookPreviewSource } from '../../lib/spray/spray-look-preview';
import { canPickBackground, type SprayBackgroundGate } from './spray-background-gate';
import { sprayBackgroundOptions } from './spray-look-model';
import { SprayWallBackgroundPreview } from './SprayWallBackgroundPreview';

type BackgroundOption = { key: SprayWallBackground; label: string };
type BackgroundCardProps = {
  option: BackgroundOption;
  selected: boolean;
  disabled: boolean;
  width: number;
  imageHeight: number;
  previewSource: SprayLookPreviewSource | null;
  unavailable: boolean;
  onSelect: (background: SprayWallBackground) => void;
};

const BackgroundCard = memo(function BackgroundCard({
  option,
  selected,
  disabled,
  width,
  imageHeight,
  previewSource,
  unavailable,
  onSelect,
}: BackgroundCardProps) {
  const { systemColors, brandColors } = useTheme();
  const handlePress = useCallback(() => onSelect(option.key), [onSelect, option.key]);
  return (
    <PressableSurface
      accessibilityRole="radio"
      accessibilityLabel={option.label}
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={handlePress}
      style={[styles.card, { width }]}
      testID={`spray-background-card-${option.key}`}
    >
      <View
        style={[
          styles.image,
          {
            height: imageHeight,
            backgroundColor: systemColors.secondaryBackground,
            borderColor: selected ? brandColors.primary : systemColors.separator,
          },
        ]}
      >
        <SprayWallBackgroundPreview value={option.key} previewSource={previewSource} unavailable={unavailable} />
      </View>
      <Text variant="subheadline" style={styles.label}>
        {option.label}
      </Text>
    </PressableSurface>
  );
});

/** Each background remains visible as a neighboring card, picked by swipe or tap. */
export const SprayWallBackgroundCarousel = memo(function SprayWallBackgroundCarousel({
  gate,
  value,
  previewSource,
  unavailable = false,
  disabled = false,
  height,
  onChange,
}: {
  gate: SprayBackgroundGate;
  value: SprayWallBackground;
  previewSource: SprayLookPreviewSource | null;
  unavailable?: boolean;
  disabled?: boolean;
  height: number;
  onChange: (background: SprayWallBackground) => void;
}) {
  const { t } = useTranslation('boards');
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setMeasuredWidth(event.nativeEvent.layout.width);
  }, []);
  const options = useMemo(
    () => sprayBackgroundOptions(t).filter((option) => canPickBackground(gate, option.key)),
    [t, gate],
  );
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.key === value),
  );
  const railWidth = measuredWidth || windowWidth;
  const captionHeight = 24 * Math.min(fontScale, 1.5) + spacing[3];
  const imageHeight = Math.max(168, height - captionHeight - spacing[3] * 2 - 6);
  const aspect = previewSource ? previewSource.frame.width / previewSource.frame.height : 0.75;
  const cardWidth = Math.max(RAIL_MIN_WIDTH, Math.min(railWidth * 0.72, imageHeight * aspect));
  const select = useCallback(
    (background: SprayWallBackground) => {
      if (!disabled && background !== value && canPickBackground(gate, background)) onChange(background);
    },
    [disabled, value, gate, onChange],
  );
  const handleSnap = useCallback(
    (index: number) => {
      const option = options[index];
      if (option) select(option.key);
    },
    [options, select],
  );
  const extraData = useMemo(
    () => ({ value, disabled, cardWidth, imageHeight, previewSource, unavailable }),
    [value, disabled, cardWidth, imageHeight, previewSource, unavailable],
  );
  const renderItem = useCallback(
    ({ item }: { item: BackgroundOption }) => (
      <BackgroundCard
        option={item}
        selected={item.key === value}
        disabled={disabled}
        width={cardWidth}
        imageHeight={imageHeight}
        previewSource={previewSource}
        unavailable={unavailable}
        onSelect={select}
      />
    ),
    [value, disabled, cardWidth, imageHeight, previewSource, unavailable, select],
  );
  return (
    <View style={styles.root} onLayout={handleLayout} testID="spray-background-carousel">
      <View style={styles.rail}>
        <SnapCarousel
          data={options}
          cardWidth={cardWidth}
          renderItem={renderItem}
          keyExtractor={backgroundKey}
          extraData={extraData}
          align="center"
          windowWidth={railWidth}
          activeIndex={selectedIndex}
          initialScrollIndex={selectedIndex}
          onSnapToIndex={disabled ? undefined : handleSnap}
          drawDistance={cardWidth}
          accessibilityLabel={t('sprayBackground.label')}
        />
      </View>
      <RailIndexDots count={options.length} activeIndex={selectedIndex} />
    </View>
  );
});

function backgroundKey(option: BackgroundOption) {
  return option.key;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  rail: { flex: 1 },
  card: { gap: spacing[3] },
  image: { borderWidth: 3, borderRadius: borderRadius.lg, overflow: 'hidden' },
  label: { textAlign: 'center' },
});
