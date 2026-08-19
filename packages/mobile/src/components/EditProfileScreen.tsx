import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { UpdateProfileInput } from '@boardsesh/shared-schema';
import { useTheme } from '../providers/theme-provider';
import { useToast } from '../providers/toast-provider';
import { useProfile, useUpdateProfile } from '../lib/graphql/hooks';
import { MAX_AVATAR_BYTES, uploadAvatar, type AvatarUploadFile } from '../lib/avatar-upload';
import { reportError, reportHandledError } from '../lib/error-reporting';
import { spacing } from '../theme/tokens';
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

/**
 * Filenames for the image types the backend accepts (`ALLOWED_MIME_TYPES` in
 * `packages/backend/src/handlers/avatars.ts`, which derives the stored file's
 * extension from the declared type). Only consulted for the fallback: the
 * compressed path re-encodes to JPEG, so it knows what it produced. A pick the
 * picker reports as anything else — HEIC, most often, straight off an Android
 * camera roll — can't be uploaded honestly without the manipulator, so the
 * fallback refuses it rather than mislabelling the bytes as JPEG.
 */
const FALLBACK_FILE_NAMES: Partial<Record<string, string>> = {
  'image/jpeg': 'avatar.jpg',
  'image/png': 'avatar.png',
  'image/gif': 'avatar.gif',
  'image/webp': 'avatar.webp',
};

/**
 * Resize (if needed) and re-encode a picked image to a small JPEG, returning the
 * local file URI. Resizing a single dimension preserves the aspect ratio; we
 * constrain whichever side is longer. A 0 dimension (the picker couldn't report
 * size) skips the resize but still re-encodes to shrink the file.
 */
async function renderCompressedJpeg(asset: ImagePicker.ImagePickerAsset): Promise<string> {
  const context = ImageManipulator.manipulate(asset.uri);
  const longestSide = Math.max(asset.width, asset.height);
  if (longestSide > MAX_DIMENSION) {
    if (asset.width >= asset.height) {
      context.resize({ width: MAX_DIMENSION });
    } else {
      context.resize({ height: MAX_DIMENSION });
    }
  }
  const image = await context.renderAsync();
  try {
    const result = await image.saveAsync({ compress: COMPRESSION_QUALITY, format: SaveFormat.JPEG });
    return result.uri;
  } finally {
    // Release the native bitmap the rendered ref holds; the saved file URI is a
    // path on disk and stays valid after the ref is gone.
    image.release();
  }
}

/**
 * Thrown when neither the compressed image nor the picker's own crop is usable.
 * Named so `handlePickAvatar` can tell it apart: `compressAvatar` has already
 * reported it with the byte counts attached, and reporting again there would
 * file the same failure twice.
 */
class AvatarCompressionError extends Error {
  override name = 'AvatarCompressionError';
}

/**
 * Compress a picked image and hand back both its URI and its bytes, so nothing
 * downstream has to trust that the file on disk is an image.
 *
 * Android's `saveAsync` throws away the `Boolean` that `Bitmap.compress()`
 * returns, so a failed encode still resolves with a URI — pointing at a 0-byte
 * file. iOS raises `CorruptedImageDataException` at the same spot, which is why
 * only Android saw this. Nothing further down noticed either: reading an empty
 * file returns an empty array without throwing, the multipart encoder writes a
 * zero-length part, and the backend answered 200 with a URL we persisted. The
 * user watched the crop land in the preview and lost it on the next screen.
 *
 * So check the bytes here, where we can still recover: fall back to the picker's
 * own crop, which is already square (`aspect: [1, 1]`) and only misses the
 * resize/re-encode. `expo-image-picker`'s Android exporter drops the same
 * `Boolean`, so the fallback gets its own length check instead of being trusted.
 */
async function compressAvatar(asset: ImagePicker.ImagePickerAsset): Promise<AvatarUploadFile> {
  let compressedBytes = new Uint8Array();
  let failure: unknown = null;
  try {
    const compressedUri = await renderCompressedJpeg(asset);
    compressedBytes = await new File(compressedUri).bytes();
    if (compressedBytes.length > 0) {
      return { uri: compressedUri, bytes: compressedBytes, name: 'avatar.jpg', type: 'image/jpeg' };
    }
  } catch (error) {
    failure = error;
  }

  let originalBytes = new Uint8Array();
  try {
    originalBytes = await new File(asset.uri).bytes();
  } catch (error) {
    // Keep the manipulator's failure if there already is one — it explains more
    // than "the picker's file wouldn't read either".
    failure ??= error;
  }

  // The fallback skips the re-encode, so these bytes are whatever the picker
  // handed us — on Android that is routinely PNG or HEIC, not JPEG. Send them
  // under their real type, and give up when it isn't one the backend takes.
  const fallbackType = asset.mimeType;
  const fallbackName = fallbackType ? FALLBACK_FILE_NAMES[fallbackType] : undefined;
  const canUseOriginal =
    fallbackName !== undefined && originalBytes.length > 0 && originalBytes.length <= MAX_AVATAR_BYTES;

  // There is no telemetry on this path today (zero avatar/manipulator/picker
  // events in 90 days), which is exactly why the failure went unnoticed for so
  // long. Sizes, MIME type and platform only — no URIs, no user identifiers.
  // Reported once, here, at the severity the climber actually experiences: a
  // warning when the fallback rescues the save, an error when they lose the pick.
  reportHandledError(failure ?? new Error('Avatar compression produced an empty file'), {
    level: canUseOriginal ? 'warning' : 'error',
    tags: { source: 'avatar-compress' },
    extra: {
      compressedBytes: compressedBytes.length,
      originalBytes: originalBytes.length,
      originalType: fallbackType ?? 'unknown',
      platform: Platform.OS,
    },
  });

  if (!canUseOriginal) {
    throw new AvatarCompressionError('Avatar compression produced an unusable file');
  }
  return { uri: asset.uri, bytes: originalBytes, name: fallbackName, type: fallbackType };
}

export function EditProfileScreen() {
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const router = useRouter();

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
  const hasChanges = pickedAvatar != null || trimmedName.length > 0;
  const canSave = !isSaving && !nameTooLong && hasChanges && !!profile?.id;

  const handlePickAvatar = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        showToast(t('profile.avatar.permissionDenied'), 'warning');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        // We compress ourselves below; ask the picker for the full-quality crop.
        quality: 1,
      });
      if (result.canceled) return;
      setPickedAvatar(await compressAvatar(result.assets[0]));
    } catch (error) {
      // `compressAvatar` already reported this one with the byte counts attached.
      if (!(error instanceof AvatarCompressionError)) {
        reportError(error);
      }
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

      if (pickedAvatar) {
        try {
          input.avatarUrl = await uploadAvatar(pickedAvatar, profile.id);
        } catch (error) {
          // Match web: a failed avatar upload warns but still saves the name, so
          // the user doesn't lose a name edit to an image hiccup.
          reportError(error);
          showToast(t('profile.avatarUploadFailed'), 'warning');
        }
      }

      // Nothing left to persist — e.g. an avatar-only save whose upload failed.
      // Stay on the screen (no router.back) so the user can retry; the warning
      // toast already fired, and `finally` still resets the saving state.
      if (input.displayName === undefined && input.avatarUrl === undefined) {
        return;
      }

      await updateProfile.mutateAsync(input);
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

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.subtitle}>
        {t('profile.subtitle')}
      </Text>

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
        <Text variant="footnote" color={systemColors.tertiaryLabel} style={styles.avatarHint}>
          {t('profile.avatar.hintMobile')}
        </Text>
      </View>

      <View style={styles.form}>
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

      <View style={styles.actions}>
        <Button
          title={t('profile.save')}
          variant="filled"
          onPress={() => {
            void handleSave();
          }}
          disabled={!canSave}
          loading={isSaving}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    paddingTop: spacing[4],
    paddingBottom: spacing[8],
  },
  subtitle: {
    paddingHorizontal: spacing[4],
    textAlign: 'center',
  },
  avatarBlock: {
    alignItems: 'center',
    gap: spacing[3],
    marginTop: spacing[5],
    paddingHorizontal: spacing[4],
  },
  avatarHint: {
    textAlign: 'center',
  },
  form: {
    marginTop: spacing[6],
    paddingHorizontal: spacing[4],
    gap: spacing[4],
  },
  actions: {
    marginTop: spacing[6],
    paddingHorizontal: spacing[4],
  },
});
