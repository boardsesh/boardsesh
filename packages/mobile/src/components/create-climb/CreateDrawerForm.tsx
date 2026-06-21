import { useMemo } from 'react';
import { View, StyleSheet, type TextStyle } from 'react-native';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { SwitchRow } from '../SwitchRow';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';

const DESCRIPTION_MAX = 500;

type CreateDrawerFormProps = {
  description: string;
  onChangeDescription: (next: string) => void;
  noMatch: boolean;
  onChangeNoMatch: (next: boolean) => void;
  isDraft: boolean;
  onChangeIsDraft: (next: boolean) => void;
  showAllHolds: boolean;
  onChangeShowAllHolds: (next: boolean) => void;
};

/**
 * The below-the-fold create form: the description text area and the climb-rule /
 * editor toggles (no-match, save-as-draft, show-all-holds). Board (BLE) connect
 * lives in the header lightbulb. Expects an spacing[4]-horizontally-padded
 * parent (the switches bleed to the drawer edges).
 */
export function CreateDrawerForm({
  description,
  onChangeDescription,
  noMatch,
  onChangeNoMatch,
  isDraft,
  onChangeIsDraft,
  showAllHolds,
  onChangeShowAllHolds,
}: CreateDrawerFormProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();

  const inputStyle = useMemo<TextStyle>(
    () => ({
      backgroundColor: systemColors.fill,
      color: systemColors.label,
      borderRadius: borderRadius.md,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[3],
      fontSize: 16,
    }),
    [systemColors],
  );

  return (
    <View style={styles.body}>
      <Text variant="footnote" style={styles.label}>
        {t('createClimbForm.fields.description')}
      </Text>
      <BottomSheetTextInput
        value={description}
        onChangeText={onChangeDescription}
        placeholder={t('createClimbForm.descriptionPlaceholder')}
        placeholderTextColor={systemColors.tertiaryLabel}
        maxLength={DESCRIPTION_MAX}
        multiline
        style={[inputStyle, styles.multiline]}
      />

      <View style={styles.switches}>
        <SwitchRow
          label={t('mobile.create.settings.noMatchLabel')}
          description={t('mobile.create.settings.noMatchDescription')}
          value={noMatch}
          onValueChange={onChangeNoMatch}
        />
        <SwitchRow
          label={t('mobile.create.settings.draftLabel')}
          description={t('mobile.create.settings.draftDescription')}
          value={isDraft}
          onValueChange={onChangeIsDraft}
        />
        <SwitchRow
          label={t('mobile.create.settings.showAllHoldsLabel')}
          description={t('mobile.create.settings.showAllHoldsDescription')}
          value={showAllHolds}
          onValueChange={onChangeShowAllHolds}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: spacing[2],
  },
  label: {
    opacity: 0.6,
  },
  multiline: {
    minHeight: 88,
    textAlignVertical: 'top',
  },
  switches: {
    marginTop: spacing[2],
    marginHorizontal: -spacing[4],
  },
});
