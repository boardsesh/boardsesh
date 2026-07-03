import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { Gym, UpdateGymInput } from '@boardsesh/shared-schema';
import { useGym, useUpdateGym } from '../../src/lib/graphql/hooks';
import { useToast } from '../../src/providers/toast-provider';
import { useTheme } from '../../src/providers/theme-provider';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';
import { hapticSelection } from '../../src/lib/haptics';
import { GymForm, type GymFormSeed, type GymFormSubmitValues } from '../../src/components/gym-directory/GymForm';
import { Text } from '../../src/components/Text';
import { Icon } from '../../src/components/Icon';
import { Button } from '../../src/components/Button';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { iosSystemColors } from '../../src/theme/ios-colors';
import { spacing } from '../../src/theme/tokens';

/**
 * Edit a gym the viewer can edit — the native counterpart of the web gym editor.
 * Reached from the wall finder's edit affordance (shown only when `gym.canEdit`).
 * Loads any gym by uuid, then hands a remounted-per-gym form to {@link EditGymForm}.
 * The root Stack hides headers, so this opts into one (back button + title).
 */
export default function EditGym() {
  const router = useRouter();
  const { gymUuid } = useLocalSearchParams<{ gymUuid?: string }>();
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const screenOptions = useStackScreenOptions();

  const { data: gym, isLoading } = useGym(gymUuid ?? null);

  const header = (
    <Stack.Screen options={{ ...screenOptions, title: t('mobile.gymEdit.screenTitle'), headerShown: true }} />
  );

  if (isLoading) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        {header}
        <ActivityIndicator size="large" />
      </View>
    );
  }

  // Missing (deleted elsewhere / stale link): nothing to edit, so offer a way back
  // rather than a broken form.
  if (!gym) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        {header}
        <Icon name="error" size={40} color={iosSystemColors.systemGray} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.gymEdit.notFound')}
        </Text>
        <Button
          title={t('mobile.gymEdit.back')}
          variant="outlined"
          onPress={() => router.back()}
          style={styles.stateButton}
        />
      </View>
    );
  }

  // The edit affordance is only shown when the viewer can edit, but a direct
  // deep-link can still land here. The server rejects the save regardless, so
  // show a clear "no access" state instead of a form that can only fail.
  if (!gym.canEdit) {
    return (
      <View style={[styles.centered, { backgroundColor: systemColors.background }]}>
        {header}
        <Icon name="lock" size={40} color={iosSystemColors.systemGray} />
        <Text variant="headline" style={styles.stateTitle}>
          {t('mobile.gymEdit.noAccess')}
        </Text>
        <Button
          title={t('mobile.gymEdit.back')}
          variant="outlined"
          onPress={() => router.back()}
          style={styles.stateButton}
        />
      </View>
    );
  }

  // Remount the form per gym so its once-only field seeds come from a fully-loaded
  // gym (mirrors the board-edit screen). The wrapper paints `background` like the
  // states above — the glass contentStyle is transparent (see changelog.tsx).
  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      {header}
      <EditGymForm key={gym.uuid} gym={gym} />
    </View>
  );
}

function EditGymForm({ gym }: { gym: Gym }) {
  const router = useRouter();
  const { t } = useTranslation('boards');
  const { showToast } = useToast();
  const updateGym = useUpdateGym();

  const seed = useMemo<GymFormSeed>(
    () => ({
      name: gym.name,
      description: gym.description ?? '',
      address: gym.address ?? '',
      contactEmail: gym.contactEmail ?? '',
      contactPhone: gym.contactPhone ?? '',
      latitude: gym.latitude ?? null,
      longitude: gym.longitude ?? null,
      isPublic: gym.isPublic,
    }),
    [gym],
  );

  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(
    async (values: GymFormSubmitValues) => {
      if (submitting) return;
      // Fields are sent as-is. The form yields `null` for a blanked field, which
      // tells the server to clear it (coordinates also clear the PostGIS
      // location); `undefined` would mean "leave unchanged". `name`/`isPublic`
      // are never null.
      const input: UpdateGymInput = {
        gymUuid: gym.uuid,
        name: values.name,
        description: values.description,
        address: values.address,
        contactEmail: values.contactEmail,
        contactPhone: values.contactPhone,
        latitude: values.latitude,
        longitude: values.longitude,
        isPublic: values.isPublic,
      };
      setSubmitting(true);
      hapticSelection();
      try {
        await updateGym.mutateAsync(input);
        showToast(t('mobile.gymEdit.updateSuccess'), 'success');
        router.back();
        // Navigated away on success — leave `submitting` set (unmounting).
      } catch {
        // The server enforces edit access authoritatively; surface a retry on any
        // rejection.
        showToast(t('mobile.gymEdit.updateError'), 'error');
        setSubmitting(false);
      }
    },
    [submitting, gym.uuid, updateGym, showToast, t, router],
  );

  return (
    <GymForm
      seed={seed}
      submitting={submitting}
      onSubmit={(values) => void handleSubmit(values)}
      submitLabel={t('mobile.gymEdit.save')}
    />
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[8],
  },
  stateTitle: {
    marginTop: spacing[3],
    textAlign: 'center',
  },
  stateButton: {
    marginTop: spacing[4],
  },
});
