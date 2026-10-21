import { Text } from '../Text';
import { useTypographyStyles, type TypographyScale } from '../../hooks/use-typography-styles';
import { createElement, type ChangeEvent, type CSSProperties } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { makeAngleSliderHandler, sliderIndexForAngle } from './AngleSlider.logic';
import type { AngleSliderProps } from './AngleSlider.types';

export function AngleSlider({ angles, value, onChange, accessibilityLabel, showValue = true }: AngleSliderProps) {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('climbs');
  const { brandColors, systemColors } = useTheme();
  if (angles.length === 0) return null;

  const valueIndex = sliderIndexForAngle(angles, value);
  const handleSliderValue = makeAngleSliderHandler(angles, valueIndex, onChange);
  const rangeStyle: CSSProperties = {
    // A control on the card takes `primary`, as the native sliders do; the
    // dark-mode fill is under 3:1 there.
    accentColor: brandColors.primary,
    cursor: 'pointer',
    flex: 1,
    minWidth: 0,
  };

  const rangeInput = createElement('input', {
    type: 'range',
    min: 0,
    max: angles.length - 1,
    step: 1,
    value: valueIndex,
    'aria-label': accessibilityLabel ?? t('angleSelector.selectAngle'),
    // The range runs in INDEX space; without this a screen reader reads "4".
    'aria-valuetext': `${angles[valueIndex]}°`,
    onChange: (event: ChangeEvent<HTMLInputElement>) => handleSliderValue(Number(event.currentTarget.value)),
    style: rangeStyle,
  });

  return (
    <View style={styles.container}>
      {rangeInput}
      {showValue ? (
        <Text style={[styles.value, { color: systemColors.label as string }]}>{`${angles[valueIndex]}°`}</Text>
      ) : null}
    </View>
  );
}

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    container: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: spacing[4],
      minHeight: 48,
      width: '100%',
    },
    value: {
      fontSize: textStyles.body.fontSize,
      fontWeight: '600',
      minWidth: 56,
      textAlign: 'center',
    },
  });
