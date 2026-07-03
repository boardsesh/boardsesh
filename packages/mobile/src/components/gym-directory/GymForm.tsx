import { useCallback, useState, type ComponentProps, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../providers/theme-provider';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { SwitchRow } from '../SwitchRow';
import { Text } from '../Text';
import { Button } from '../Button';
import { spacing, borderRadius } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import { parseCoordinate, LATITUDE_RANGE, LONGITUDE_RANGE } from './gym-coordinate';

/** The gym's current values, used to seed the form once on mount. */
export type GymFormSeed = {
  name: string;
  description: string;
  address: string;
  website: string;
  contactEmail: string;
  contactPhone: string;
  latitude: number | null;
  longitude: number | null;
  isPublic: boolean;
};

/** The normalized values handed back on submit. Text fields collapse to `null`
 *  when blank; coordinates parse to a finite number or `null`. */
export type GymFormSubmitValues = {
  name: string;
  description: string | null;
  address: string | null;
  website: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  latitude: number | null;
  longitude: number | null;
  isPublic: boolean;
};

type GymFormProps = {
  seed: GymFormSeed;
  submitting: boolean;
  onSubmit: (values: GymFormSubmitValues) => void;
  submitLabel: string;
  /** Extra sections rendered inside the scroll, below the fields (e.g. the
   *  write-access manager and the claim entry on the gym-edit screen). */
  extraSections?: ReactNode;
};

function coordToText(value: number | null): string {
  return value == null ? '' : String(value);
}

/**
 * The gym editor form — name, description, address, contact email/phone,
 * coordinates, and a public toggle, with a pinned primary action. The native
 * (StyleSheet + theme) counterpart of the web gym form; the gym-edit screen owns
 * the mutation, success toast, and navigation. Seeds its fields once via the
 * `useState` initializers, so re-renders never clobber in-progress edits (the
 * screen remounts it per gym).
 */
export function GymForm({ seed, submitting, onSubmit, submitLabel, extraSections }: GymFormProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const bottomChrome = useBottomChromeMetrics();

  const [name, setName] = useState(seed.name);
  const [description, setDescription] = useState(seed.description);
  const [address, setAddress] = useState(seed.address);
  const [website, setWebsite] = useState(seed.website);
  const [contactEmail, setContactEmail] = useState(seed.contactEmail);
  const [contactPhone, setContactPhone] = useState(seed.contactPhone);
  const [latitudeText, setLatitudeText] = useState(coordToText(seed.latitude));
  const [longitudeText, setLongitudeText] = useState(coordToText(seed.longitude));
  const [isPublic, setIsPublic] = useState(seed.isPublic);

  const trimmedName = name.trim();
  const latitude = parseCoordinate(latitudeText, LATITUDE_RANGE.min, LATITUDE_RANGE.max);
  const longitude = parseCoordinate(longitudeText, LONGITUDE_RANGE.min, LONGITUDE_RANGE.max);
  const canSubmit = trimmedName.length > 0 && !submitting && !latitude.error && !longitude.error;

  const handleSubmit = useCallback(() => {
    const lat = parseCoordinate(latitudeText, LATITUDE_RANGE.min, LATITUDE_RANGE.max);
    const lon = parseCoordinate(longitudeText, LONGITUDE_RANGE.min, LONGITUDE_RANGE.max);
    if (trimmedName.length === 0 || submitting || lat.error || lon.error) return;
    onSubmit({
      name: trimmedName,
      description: description.trim() || null,
      address: address.trim() || null,
      website: website.trim() || null,
      contactEmail: contactEmail.trim() || null,
      contactPhone: contactPhone.trim() || null,
      latitude: lat.value,
      longitude: lon.value,
      isPublic,
    });
  }, [
    trimmedName,
    submitting,
    onSubmit,
    description,
    address,
    website,
    contactEmail,
    contactPhone,
    latitudeText,
    longitudeText,
    isPublic,
  ]);

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.content, { paddingBottom: bottomChrome.scrollBottomPadding + spacing[16] }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <SectionLabel>{t('mobile.gymEdit.name')}</SectionLabel>
        <GymTextInput
          value={name}
          onChangeText={setName}
          placeholder={t('mobile.gymEdit.namePlaceholder')}
          accessibilityLabel={t('mobile.gymEdit.name')}
          maxLength={100}
          returnKeyType="next"
        />

        <SectionLabel>{t('mobile.gymEdit.description')}</SectionLabel>
        <GymTextInput
          value={description}
          onChangeText={setDescription}
          placeholder={t('mobile.gymEdit.descriptionPlaceholder')}
          accessibilityLabel={t('mobile.gymEdit.description')}
          maxLength={500}
          multiline
          style={styles.multiline}
        />

        <SectionLabel>{t('mobile.gymEdit.address')}</SectionLabel>
        <GymTextInput
          value={address}
          onChangeText={setAddress}
          placeholder={t('mobile.gymEdit.addressPlaceholder')}
          accessibilityLabel={t('mobile.gymEdit.address')}
          maxLength={200}
        />

        <SectionLabel>{t('mobile.gymEdit.website')}</SectionLabel>
        <GymTextInput
          value={website}
          onChangeText={setWebsite}
          placeholder={t('mobile.gymEdit.websitePlaceholder')}
          accessibilityLabel={t('mobile.gymEdit.website')}
          keyboardType="url"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={500}
        />
        <Text variant="footnote" color={systemColors.tertiaryLabel} style={styles.fieldHint}>
          {t('mobile.gymEdit.websiteHint')}
        </Text>

        <SectionLabel>{t('mobile.gymEdit.contactEmail')}</SectionLabel>
        <GymTextInput
          value={contactEmail}
          onChangeText={setContactEmail}
          placeholder={t('mobile.gymEdit.contactEmailPlaceholder')}
          accessibilityLabel={t('mobile.gymEdit.contactEmail')}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={200}
        />

        <SectionLabel>{t('mobile.gymEdit.contactPhone')}</SectionLabel>
        <GymTextInput
          value={contactPhone}
          onChangeText={setContactPhone}
          placeholder={t('mobile.gymEdit.contactPhonePlaceholder')}
          accessibilityLabel={t('mobile.gymEdit.contactPhone')}
          keyboardType="phone-pad"
          maxLength={30}
        />

        <View style={styles.coordRow}>
          <View style={styles.coordField}>
            <SectionLabel>{t('mobile.gymEdit.latitude')}</SectionLabel>
            <GymTextInput
              value={latitudeText}
              onChangeText={setLatitudeText}
              placeholder={t('mobile.gymEdit.coordinatePlaceholder')}
              accessibilityLabel={t('mobile.gymEdit.latitude')}
              keyboardType="numbers-and-punctuation"
              autoCorrect={false}
              maxLength={20}
            />
            {latitude.error && (
              <Text variant="footnote" color={iosSystemColors.systemRed} style={styles.coordError}>
                {t('mobile.gymEdit.invalidCoordinate')}
              </Text>
            )}
          </View>
          <View style={styles.coordField}>
            <SectionLabel>{t('mobile.gymEdit.longitude')}</SectionLabel>
            <GymTextInput
              value={longitudeText}
              onChangeText={setLongitudeText}
              placeholder={t('mobile.gymEdit.coordinatePlaceholder')}
              accessibilityLabel={t('mobile.gymEdit.longitude')}
              keyboardType="numbers-and-punctuation"
              autoCorrect={false}
              maxLength={20}
            />
            {longitude.error && (
              <Text variant="footnote" color={iosSystemColors.systemRed} style={styles.coordError}>
                {t('mobile.gymEdit.invalidCoordinate')}
              </Text>
            )}
          </View>
        </View>

        <View style={styles.switchBlock}>
          <SwitchRow
            label={t('mobile.gymEdit.public')}
            description={t('mobile.gymEdit.publicHint')}
            value={isPublic}
            onValueChange={setIsPublic}
          />
        </View>

        {extraSections}
      </ScrollView>

      {/* Pinned, safe-area-aware primary action — mirrors the board form footer. */}
      <View
        style={[
          styles.footer,
          {
            backgroundColor: systemColors.secondaryBackground,
            borderTopColor: systemColors.separator,
            paddingBottom: insets.bottom + spacing[3],
          },
        ]}
      >
        <Button
          title={submitLabel}
          onPress={handleSubmit}
          variant="filled"
          size="large"
          disabled={!canSubmit}
          loading={submitting}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

function SectionLabel({ children }: { children: string }) {
  const { systemColors } = useTheme();
  return (
    <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.sectionLabel}>
      {children}
    </Text>
  );
}

/** Themed text input for the gym form fields. Mirrors the board form's input. */
function GymTextInput({ style, ...props }: ComponentProps<typeof TextInput>) {
  const { systemColors } = useTheme();
  return (
    <TextInput
      placeholderTextColor={systemColors.tertiaryLabel}
      {...props}
      style={[
        styles.input,
        {
          color: systemColors.label,
          borderColor: systemColors.separator,
          backgroundColor: systemColors.secondaryBackground,
        },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  content: {
    padding: spacing[4],
    gap: spacing[2],
  },
  sectionLabel: {
    marginTop: spacing[3],
    marginBottom: spacing[1],
    textTransform: 'uppercase',
  },
  input: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 17,
  },
  multiline: {
    minHeight: 88,
    textAlignVertical: 'top',
  },
  fieldHint: {
    marginTop: spacing[1],
  },
  coordRow: {
    flexDirection: 'row',
    gap: spacing[3],
  },
  coordField: {
    flex: 1,
  },
  coordError: {
    marginTop: spacing[1],
  },
  switchBlock: {
    marginTop: spacing[4],
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
