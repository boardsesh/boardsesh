import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import * as ImagePicker from 'expo-image-picker';
import type { UpdateProfileInput } from '@boardsesh/shared-schema';
import { useTheme } from '../providers/theme-provider';
import { useToast } from '../providers/toast-provider';
import { useHeaderActions } from '../hooks/use-header-actions';
import { useKeyboardHeight } from '../hooks/use-keyboard-height';
import { useBottomChromeMetrics } from '../hooks/use-bottom-chrome-metrics';
import { useProfile, useUpdateProfile } from '../lib/graphql/hooks';
import { uploadAvatar, type AvatarUploadFile } from '../lib/avatar-upload';
import { compressPickedImage } from '../lib/image-compression';
import { reportError } from '../lib/error-reporting';
import { borderRadius, spacing } from '../theme/tokens';
import { Avatar } from './Avatar';
import { AuthTextInput } from './AuthTextInput';
import { Button } from './Button';
import { Text } from './Text';

const DISPLAY_NAME_MAX = 100;
// Cap the longest side at 1024px and re-encode as JPEG q0.85 so a
// multi-megapixel camera photo lands comfortably under the backend's 2MB
// avatar limit.
const MAX_DIMENSION = 1024;
const COMPRESSION_QUALITY = 0.85;

export function EditProfileScreen() {
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const router = useRouter();
  const { scrollBottomPadding } = useBottomChromeMetrics();
  const headerHeight = useHeaderHeight();
  const keyboardHeight = useKeyboardHeight(Platform.OS === 'android');

  const { data: profile } = useProfile();
  const updateProfile = useUpdateProfile();

  const [displayName, setDisplayName] = useState('');
  const [pickedAvatar, setPickedAvatar] = useState<AvatarUploadFile | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Seed the name field from the loaded profile exactly once. The query is
  // usually warm (the avatar/drawer already read it), but on a cold load the
  // field is editable before `profile` resolves — so also skip the seed if the
  // user has already typed, or the late resolve would clobber their edit.
  const seededRef = useRef(false);
  const nameEditedRef = useRef(false);
  useEffect(() => {
    if (!seededRef.current && !nameEditedRef.current && profile) {
      setDisplayName(profile.displayName ?? '');
      seededRef.current = true;
    }
  }, [profile]);

  const handleChangeName = useCallback((text: string) => {
    nameEditedRef.current = true;
    setDisplayName(text);
  }, []);

  const trimmedName = displayName.trim();
  const nameTooLong = trimmedName.length > DISPLAY_NAME_MAX;
  const previewUri = pickedAvatar?.uri ?? profile?.avatarUrl;
  const avatarName = trimmedName || profile?.email || null;
  // Dirty means different from what is saved: a name typed back to the saved one
  // has nothing to save, and the ✓ stays grey.
  const savedName = (profile?.displayName ?? '').trim();
  const hasChanges = pickedAvatar != null || (trimmedName.length > 0 && trimmedName !== savedName);
  const canSave = !isSaving && !nameTooLong && hasChanges && !!profile?.id;

  const handlePickAvatar = async () => {
    try {
      // No library permission request: the system picker needs none (#5957).
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        // We compress ourselves below; ask the picker for the full-quality crop.
        quality: 1,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      const compressedUri = await compressPickedImage(asset.uri, asset.width, asset.height, {
        maxDimension: MAX_DIMENSION,
        quality: COMPRESSION_QUALITY,
      });
      setPickedAvatar({ uri: compressedUri, name: 'avatar.jpg', type: 'image/jpeg' });
    } catch (error) {
      reportError(error);
      showToast(t('profile.validation.compressionFailed'), 'error');
    }
  };

  // Synchronous reentrancy guard: `canSave`/`isSaving` are state read from the
  // render closure and don't update until the next render, so a fast double-tap
  // could enter `handleSave` twice (double upload + double router.back). The ref
  // flips immediately.
  const savingRef = useRef(false);

  const handleSave = async () => {
    if (savingRef.current || !canSave || !profile?.id) return;
    savingRef.current = true;
    setIsSaving(true);
    try {
      const input: UpdateProfileInput = {};
      if (trimmedName.length > 0) {
        input.displayName = trimmedName;
      }

      let avatarUploadFailed = false;
      if (pickedAvatar) {
        try {
          input.avatarUrl = await uploadAvatar(pickedAvatar, profile.id);
        } catch (error) {
          // Keep the name edit, but leave the selected photo here for retry.
          avatarUploadFailed = true;
          reportError(error);
          showToast(t('profile.avatarUploadFailed'), 'warning');
        }
      }

      // With no profile fields to persist, keep the form open for another try.
      // `finally` still resets the saving state.
      if (input.displayName === undefined && input.avatarUrl === undefined) {
        return;
      }

      await updateProfile.mutateAsync(input);
      if (avatarUploadFailed) return;
      // showToast fires the success/error haptic itself based on the variant.
      showToast(t('profile.saved'), 'success');
      router.back();
    } catch (error) {
      reportError(error);
      showToast(t('profile.saveError'), 'error');
    } finally {
      setIsSaving(false);
      savingRef.current = false;
    }
  };

  // Save is the top-bar ✓, never a button at the foot of the form: back is cancel.
  useHeaderActions({
    trailing: {
      kind: 'confirm',
      label: t('profile.save'),
      onPress: () => {
        void handleSave();
      },
      disabled: !canSave,
      loading: isSaving,
      prominent: true,
    },
    clearOnUnmount: true,
  });

  return (
    <KeyboardAvoidingView
      keyboardVerticalOffset={headerHeight}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.flex}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: systemColors.groupedBackground }}
        contentContainerStyle={[styles.container, { paddingBottom: scrollBottomPadding + spacing[4] + keyboardHeight }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.avatarBlock}>
          <Avatar uri={previewUri} name={avatarName} size={96} />
          <Button
            title={previewUri ? t('profile.avatar.change') : t('profile.avatar.upload')}
            variant="outlined"
            icon="camera"
            onPress={() => {
              void handlePickAvatar();
            }}
            disabled={isSaving}
          />
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.avatarHint}>
            {t('profile.avatar.hintMobile')}
          </Text>
        </View>

        <View style={[styles.card, { backgroundColor: systemColors.secondaryGroupedBackground }]}>
          <AuthTextInput
            label={t('profile.displayName.label')}
            value={displayName}
            onChangeText={handleChangeName}
            placeholder={t('profile.displayName.placeholder')}
            error={nameTooLong ? t('profile.validation.displayNameTooLong') : undefined}
            editable={!isSaving}
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="done"
          />

          <AuthTextInput
            label={t('profile.email.label')}
            value={profile?.email ?? ''}
            onChangeText={() => undefined}
            editable={false}
            hint={t('profile.email.help')}
            autoCapitalize="none"
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: {
    width: '100%',
    maxWidth: 672,
    alignSelf: 'center',
    flexGrow: 1,
    paddingTop: spacing[4],
  },
  avatarBlock: {
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
  },
  avatarHint: {
    textAlign: 'center',
  },
  card: {
    marginTop: spacing[6],
    marginHorizontal: spacing[4],
    padding: spacing[4],
    gap: spacing[4],
    borderRadius: borderRadius.lg,
  },
});
