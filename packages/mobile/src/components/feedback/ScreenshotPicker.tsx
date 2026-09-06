import { Image, StyleSheet, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useTranslation } from 'react-i18next';
import { FEEDBACK_SCREENSHOT_MAX_COUNT } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { compressPickedImage } from '../../lib/image-compression';
import { reportError } from '../../lib/error-reporting';
import { spacing, borderRadius } from '../../theme/tokens';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { Text } from '../Text';

// LIBRARY ONLY — never add camera capture here. A camera picker needs
// NSCameraUsageDescription in app.config.ts, which moves the native fingerprint
// and cuts every shipped store binary off from OTA updates. Testers take a
// screenshot with the device gesture and then pick it.
const THUMBNAIL_SIZE = 72;
// Taller than the avatar's 1024 so the small UI text in a phone screenshot is
// still readable in the GitHub comment.
const MAX_DIMENSION = 1600;
const COMPRESSION_QUALITY = 0.8;

type ScreenshotPickerProps = {
  uris: string[];
  onChange: (uris: string[]) => void;
  disabled?: boolean;
};

/**
 * Pick up to `FEEDBACK_SCREENSHOT_MAX_COUNT` screenshots off the photo library
 * for a bug report or QA verdict, and show them as a removable thumbnail strip.
 * Picking only stages local files — the sheet uploads them on submit.
 */
export function ScreenshotPicker({ uris, onChange, disabled = false }: ScreenshotPickerProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const { showToast } = useToast();

  const remaining = FEEDBACK_SCREENSHOT_MAX_COUNT - uris.length;

  const handlePick = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        showToast(t('screenshots.permissionDenied'), 'warning');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: remaining,
        // We compress ourselves below; ask the picker for the full-quality file.
        quality: 1,
      });
      if (result.canceled) return;
      const compressed = await Promise.all(
        result.assets.slice(0, remaining).map((asset) =>
          compressPickedImage(asset.uri, asset.width, asset.height, {
            maxDimension: MAX_DIMENSION,
            quality: COMPRESSION_QUALITY,
          }),
        ),
      );
      onChange([...uris, ...compressed]);
    } catch (error) {
      reportError(error);
      showToast(t('screenshots.pickFailed'), 'error');
    }
  };

  const handleRemove = (uri: string) => {
    onChange(uris.filter((entry) => entry !== uri));
  };

  return (
    <View style={styles.container}>
      <View style={styles.strip} accessibilityLabel={t('screenshots.attachedCount', { count: uris.length })}>
        {uris.map((uri) => (
          <View key={uri} style={styles.thumbnailWrapper}>
            <Image
              source={{ uri }}
              style={[styles.thumbnail, { backgroundColor: systemColors.fill }]}
              resizeMode="cover"
            />
            <PressableSurface
              onPress={() => handleRemove(uri)}
              feedback="scale"
              hitSlop={8}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={t('screenshots.removeAria')}
              style={[styles.removeButton, { backgroundColor: systemColors.secondaryBackground }]}
            >
              <Icon name="close" size={12} color={systemColors.label} />
            </PressableSurface>
          </View>
        ))}

        {remaining > 0 ? (
          <PressableSurface
            onPress={() => {
              void handlePick();
            }}
            feedback="scale"
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={t('screenshots.addAria')}
            style={[styles.addTile, { borderColor: systemColors.separator, backgroundColor: systemColors.fill }]}
          >
            <Icon name="plus" size={20} color={systemColors.secondaryLabel} />
            <Text variant="caption2" color={systemColors.secondaryLabel} numberOfLines={1}>
              {t('screenshots.addLabel')}
            </Text>
          </PressableSurface>
        ) : null}
      </View>

      <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={2}>
        {t('screenshots.publicWarning')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing[2],
  },
  strip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing[2],
  },
  thumbnailWrapper: {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE,
  },
  thumbnail: {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE,
    borderRadius: borderRadius.md,
  },
  removeButton: {
    position: 'absolute',
    top: -spacing[1],
    right: -spacing[1],
    width: 22,
    height: 22,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addTile: {
    width: THUMBNAIL_SIZE,
    height: THUMBNAIL_SIZE,
    borderRadius: borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    paddingHorizontal: spacing[1],
  },
});
