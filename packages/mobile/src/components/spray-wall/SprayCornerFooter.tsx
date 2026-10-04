// The corner step's footer, shared by "Add a spray wall" and "Reset a wall"
// (issue #5958).
//
// Its height is the same before and after the first ring is dragged, on
// purpose. "Start the corners again" used to appear only once there were corners
// to start again, which made the footer a button taller at the exact moment a
// drag ended — and the photo above it is fitted to the space the footer leaves,
// so the two bottom rings went under it. The button is always here now and is
// disabled until there is something for it to undo.

import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

export type SprayCornerFooterProps = {
  /** What the main button says: "Use these corners", or "Skip for now" where skipping is allowed. */
  primaryTitle: string;
  onPrimary: () => void;
  primaryDisabled: boolean;
  /** True once there are corners to throw away. */
  canClear: boolean;
  onClear: () => void;
  onBack: () => void;
  backDisabled: boolean;
};

export function SprayCornerFooter({
  primaryTitle,
  onPrimary,
  primaryDisabled,
  canClear,
  onClear,
  onBack,
  backDisabled,
}: SprayCornerFooterProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[styles.footer, { borderTopColor: systemColors.separator, paddingBottom: insets.bottom + spacing[3] }]}
    >
      <Button title={primaryTitle} variant="filled" size="large" onPress={onPrimary} disabled={primaryDisabled} />
      {/* One row rather than two stacked buttons: every point the footer does
          not take is a point the photo gets. */}
      <View style={styles.secondaryRow}>
        <Button
          title={t('sprayWizard.back')}
          variant="text"
          onPress={onBack}
          disabled={backDisabled}
          style={styles.secondaryButton}
        />
        <Button
          title={t('sprayWizard.anchors.clear')}
          variant="text"
          onPress={onClear}
          disabled={!canClear}
          style={styles.secondaryButton}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing[1],
  },
  secondaryRow: {
    flexDirection: 'row',
    gap: spacing[2],
  },
  secondaryButton: {
    flex: 1,
  },
});
