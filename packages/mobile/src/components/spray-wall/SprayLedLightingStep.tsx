import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSprayLedPreview } from '../../lib/spray/use-spray-led-preview';
import { useTheme } from '../../providers/theme-provider';
import { Button } from '../Button';
import { Text } from '../Text';

export function SprayLedLightingStep({
  wallUuid,
  orderedIndices,
}: {
  wallUuid: string;
  orderedIndices: readonly number[];
}) {
  const { t } = useTranslation('boards');
  const { spacing, brandColors } = useTheme();
  const preview = useSprayLedPreview(wallUuid);
  return (
    <View style={{ gap: spacing[3] }}>
      <Text variant="footnote">{t('sprayLedSetup.lightingHint')}</Text>
      {!preview.available ? <Text variant="footnote">{t('sprayLedSetup.lightingUnavailable')}</Text> : null}
      <Button
        title={t('sprayLed.lightAll')}
        variant="outlined"
        disabled={!preview.available}
        onPress={() => void preview.lightAll()}
      />
      <Button
        title={t('sprayLedSetup.lightingChase')}
        variant="outlined"
        disabled={!preview.available || orderedIndices.length === 0}
        onPress={() => void preview.chase(orderedIndices)}
      />
      <Button
        title={t('sprayLedSetup.lightingStop')}
        variant="text"
        disabled={!preview.available}
        onPress={() => void preview.stop()}
      />
      {preview.state !== 'idle' ? (
        <Text variant="footnote" accessibilityLiveRegion="polite">
          {preview.state === 'chasing'
            ? t('sprayLedSetup.lightingChasing')
            : preview.state === 'lit'
              ? t('sprayLed.lit')
              : t('sprayLed.sending')}
        </Text>
      ) : null}
      {preview.error ? (
        <Text variant="footnote" color={brandColors.error} accessibilityLiveRegion="polite">
          {preview.error === 'invalid-indices' ? t('sprayLedSetup.lightingRangeError') : t('sprayLed.lightFailed')}
        </Text>
      ) : null}
    </View>
  );
}
