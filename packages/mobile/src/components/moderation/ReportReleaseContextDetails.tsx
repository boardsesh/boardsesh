import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { ReleaseContext } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

/** Used only with server-authorized stored report diagnostics. */
export const ReportReleaseContextDetails = memo(function ReportReleaseContextDetails({
  releaseContext,
}: {
  releaseContext?: ReleaseContext | null;
}) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  if (!releaseContext) return null;
  const unknown = t('mobile.reportRelease.unknown');
  const booleanLabel = (state: boolean | null): string =>
    state === null ? unknown : state ? t('mobile.reportRelease.yes') : t('mobile.reportRelease.no');
  return (
    <View style={styles.details}>
      <Text variant="caption1" color={systemColors.secondaryLabel}>
        {t('mobile.reportRelease.title')}
      </Text>
      <Text variant="caption2" color={systemColors.secondaryLabel} selectable>
        {t('mobile.reportRelease.channel')}: {releaseContext.channel ?? unknown}
        {' · '}
        {t('mobile.reportRelease.branch')}: {releaseContext.branch ?? unknown}
      </Text>
      <Text variant="caption2" color={systemColors.secondaryLabel}>
        {t('mobile.reportRelease.automaticCanary')}: {booleanLabel(releaseContext.automaticCanary)}
        {' · '}
        {t('mobile.reportRelease.embedded')}: {booleanLabel(releaseContext.isEmbeddedLaunch)}
      </Text>
      <Text variant="caption2" color={systemColors.secondaryLabel} selectable>
        {t('mobile.reportRelease.updateId')}: {releaseContext.updateId ?? unknown}
      </Text>
      <Text variant="caption2" color={systemColors.secondaryLabel} selectable>
        {t('mobile.reportRelease.runtimeVersion')}: {releaseContext.runtimeVersion ?? unknown}
      </Text>
      {releaseContext.canaryCheckedAt ? (
        <Text variant="caption2" color={systemColors.secondaryLabel}>
          {t('mobile.reportRelease.checkedAt')}: {releaseContext.canaryCheckedAt}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({ details: { gap: spacing[1], paddingTop: spacing[1] } });
