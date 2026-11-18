import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ScreenTitle } from '../../ScreenTitle';
import { spacing } from '../../../theme/tokens';
import { PartnerWorkoutEntry } from '../PartnerWorkoutEntry';
import type { StartSessionConfig } from '../../../providers/queue-provider';
export function PreSessionHeaderView({
  tip,
  showTitle,
  board,
  timer,
  visibility,
  generator,
  preview,
  partnerStartConfig = null,
}: {
  tip?: ReactNode;
  showTitle: boolean;
  board: ReactNode;
  timer: ReactNode;
  visibility: ReactNode;
  generator: ReactNode;
  preview?: ReactNode;
  partnerStartConfig?: StartSessionConfig | null;
}) {
  const { t } = useTranslation('session');
  return (
    <View style={styles.header}>
      {tip}
      {showTitle ? <ScreenTitle style={styles.title}>{t('mobile.session.headerStart')}</ScreenTitle> : null}
      <PartnerWorkoutEntry inset startConfig={partnerStartConfig} />
      <View style={styles.inset} testID="pre-session-board-summary">
        {board}
      </View>
      <View style={styles.inset}>{timer}</View>
      <View style={styles.inset}>{visibility}</View>
      {generator}
      {preview}
    </View>
  );
}
const styles = StyleSheet.create({
  header: { gap: spacing[3] },
  inset: { paddingHorizontal: spacing[4] },
  title: { paddingHorizontal: spacing[4], paddingTop: 0, paddingBottom: spacing[2] },
});
