import { AccessibleTextInput as TextInput } from '../AccessibleTextInput';
import { useMemo } from 'react';
import { View, StyleSheet, type TextStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { SwitchRow } from '../SwitchRow';
import { offersNoKickboardRule } from './spray-climb-rules';
import { textStyles as fallbackTextStyles } from '../../theme/typography';
import { useTheme } from '../../providers/theme-provider';
import { usePartnerAppsEnabled } from '../../lib/graphql/hooks/use-connected-apps';
import { spacing, borderRadius } from '../../theme/tokens';

const DESCRIPTION_MAX = 500;

type CreateDrawerFormProps = {
  /** The board being authored on — decides which rule rows it offers. */
  boardName: string;
  description: string;
  onChangeDescription: (next: string) => void;
  noMatch: boolean;
  onChangeNoMatch: (next: boolean) => void;
  noKickboard: boolean;
  onChangeNoKickboard: (next: boolean) => void;
  campus: boolean;
  onChangeCampus: (next: boolean) => void;
  anyFeet: boolean;
  onChangeAnyFeet: (next: boolean) => void;
  /** False while the climb's MoonBoard method already forbids feet — the row is
   *  hidden rather than shown as a toggle that contradicts the climb. */
  anyFeetAvailable: boolean;
  isDraft: boolean;
  onChangeIsDraft: (next: boolean) => void;
  /** The Spraywall is public: only then do apps get its drafts' names, so only then does the draft line mention them. */
  sprayWallPublic?: boolean;
};

/**
 * The below-the-fold create form: the description text area and the climb-rule /
 * editor toggles (no-match, save-as-draft). Board (BLE) connect
 * lives in the header lightbulb. Expects an spacing[4]-horizontally-padded
 * parent (the switches bleed to the drawer edges).
 */
export function CreateDrawerForm({
  boardName,
  description,
  onChangeDescription,
  noMatch,
  onChangeNoMatch,
  noKickboard,
  onChangeNoKickboard,
  campus,
  onChangeCampus,
  anyFeet,
  onChangeAnyFeet,
  anyFeetAvailable,
  isDraft,
  onChangeIsDraft,
  sprayWallPublic = false,
}: CreateDrawerFormProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, textStyles = fallbackTextStyles } = useTheme();
  // Once partner apps are on, a draft is unlisted rather than private: apps
  // connected by climbers who log it can see it (#7387), on any board and on a
  // public Spraywall. A Private or Link only wall's climbs reach those apps
  // without their names, so its line stays as it was. Off, nothing changes.
  const partnerAppsEnabled = usePartnerAppsEnabled();

  const inputStyle = useMemo<TextStyle>(
    () => ({
      backgroundColor: systemColors.fill,
      color: systemColors.label,
      borderRadius: borderRadius.md,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[3],
      ...textStyles.callout,
    }),
    [systemColors, textStyles],
  );

  return (
    <View style={styles.body}>
      <Text variant="footnote" style={styles.label}>
        {t('createClimbForm.fields.description')}
      </Text>
      <TextInput
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
        {/* A spray wall has no kickboard, so the rule has nothing to say there. */}
        {offersNoKickboardRule(boardName) ? (
          <SwitchRow
            label={t('mobile.create.settings.noKickboardLabel')}
            description={t('mobile.create.settings.noKickboardDescription')}
            value={noKickboard}
            onValueChange={onChangeNoKickboard}
          />
        ) : null}
        {/* The two feet rules sit next to each other because they answer the same
            question, and the controller keeps them mutually exclusive: turning one
            on turns the other off. */}
        {anyFeetAvailable ? (
          <SwitchRow
            label={t('mobile.create.settings.anyFeetLabel')}
            description={t('mobile.create.settings.anyFeetDescription')}
            value={anyFeet}
            onValueChange={onChangeAnyFeet}
          />
        ) : null}
        <SwitchRow
          label={t('mobile.create.settings.campusLabel')}
          description={t('mobile.create.settings.campusDescription')}
          value={campus}
          onValueChange={onChangeCampus}
        />
        <SwitchRow
          label={t('mobile.create.settings.draftLabel')}
          description={draftDescription(boardName, partnerAppsEnabled, sprayWallPublic, t)}
          value={isDraft}
          onValueChange={onChangeIsDraft}
        />
      </View>
    </View>
  );
}

/**
 * The draft switch's description: on a board, or on a Spraywall, with the apps
 * line once partner apps are on, and on a Spraywall only when the wall is public.
 */
function draftDescription(
  boardName: string,
  partnerAppsEnabled: boolean,
  sprayWallPublic: boolean,
  t: (key: string) => string,
): string {
  if (boardName === 'spray') {
    return partnerAppsEnabled && sprayWallPublic
      ? t('mobile.create.settings.wallDraftDescriptionApps')
      : t('mobile.create.settings.wallDraftDescription');
  }
  return partnerAppsEnabled
    ? t('mobile.create.settings.draftDescriptionApps')
    : t('mobile.create.settings.draftDescription');
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
