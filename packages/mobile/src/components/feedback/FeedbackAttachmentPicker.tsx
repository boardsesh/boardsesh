import { useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useTranslation } from 'react-i18next';
import { FEEDBACK_ATTACHMENT_MAX_COUNT, FEEDBACK_RECORDING_MAX_UPLOAD_BYTES } from '@boardsesh/shared-schema';
import { useTheme } from '../../providers/theme-provider';
import { isSupportedFeedbackRecording } from '../../lib/feedback/attachment-upload';
import type { FeedbackAttachment } from '../../lib/feedback/shared-bug-draft.types';
import { reportError } from '../../lib/error-reporting';
import { getUploadFileSize } from '../../lib/upload-image';
import { spacing, borderRadius } from '../../theme/tokens';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { InlineSheetError } from '../InlineSheetError';

type FeedbackAttachmentPickerProps = {
  attachments: FeedbackAttachment[];
  onChange: (attachments: FeedbackAttachment[]) => void | Promise<void>;
  disabled?: boolean;
  stageAttachment?: (attachment: FeedbackAttachment) => Promise<FeedbackAttachment>;
  onPickingChange?: (picking: boolean) => void;
  releaseStagedAttachments?: (attachments: readonly FeedbackAttachment[]) => void;
};

export function FeedbackAttachmentPicker({
  attachments,
  onChange,
  disabled = false,
  stageAttachment,
  onPickingChange,
  releaseStagedAttachments,
}: FeedbackAttachmentPickerProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const [pickError, setPickError] = useState<string | null>(null);
  const [isPicking, setIsPicking] = useState(false);
  const pickingRef = useRef(false);
  const latestAttachments = useRef(attachments);
  latestAttachments.current = attachments;
  const remaining = FEEDBACK_ATTACHMENT_MAX_COUNT - attachments.length;

  const handlePick = async () => {
    if (disabled || pickingRef.current || remaining <= 0) return;
    pickingRef.current = true;
    setIsPicking(true);
    onPickingChange?.(true);
    setPickError(null);
    const pickedAttachments: FeedbackAttachment[] = [];
    let filesAttached = false;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsMultipleSelection: true,
        selectionLimit: remaining,
        quality: 1,
        videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
      });
      if (result.canceled) return;
      for (const asset of result.assets) {
        if (latestAttachments.current.length + pickedAttachments.length >= FEEDBACK_ATTACHMENT_MAX_COUNT) {
          setPickError(t('feedbackAttachments.tooMany'));
          break;
        }
        const kind = asset.type === 'video' ? 'video' : 'image';
        const fileSize = asset.fileSize ?? (await getUploadFileSize(asset.uri));
        const name =
          asset.fileName ??
          asset.uri.split('/').pop()?.split('?')[0] ??
          (kind === 'video' ? 'recording.mp4' : 'screenshot.jpg');
        const extension = name.toLowerCase().split('.').pop();
        const mimeType =
          asset.mimeType ??
          (kind === 'image'
            ? 'image/jpeg'
            : extension === 'mov'
              ? 'video/quicktime'
              : extension === 'webm'
                ? 'video/webm'
                : 'video/mp4');
        if (kind === 'video' && !isSupportedFeedbackRecording(mimeType)) {
          setPickError(t('feedbackAttachments.unsupported'));
          continue;
        }
        if (kind === 'video' && fileSize > FEEDBACK_RECORDING_MAX_UPLOAD_BYTES) {
          setPickError(t('feedbackAttachments.tooLarge'));
          continue;
        }
        const attachment: FeedbackAttachment = {
          id: `${Date.now()}-${pickedAttachments.length}-${Math.random().toString(36).slice(2)}`,
          kind,
          uri: asset.uri,
          name,
          mimeType,
          size: fileSize,
          width: asset.width,
          height: asset.height,
          ...(asset.duration == null ? {} : { duration: asset.duration }),
        };
        pickedAttachments.push(stageAttachment ? await stageAttachment(attachment) : attachment);
      }
      // A share can arrive while the system picker is open. Keep its files too.
      const merged = [...latestAttachments.current, ...pickedAttachments];
      if (merged.length > FEEDBACK_ATTACHMENT_MAX_COUNT) setPickError(t('feedbackAttachments.tooMany'));
      await onChange(merged.slice(0, FEEDBACK_ATTACHMENT_MAX_COUNT));
      filesAttached = true;
      releaseStagedAttachments?.(merged.slice(FEEDBACK_ATTACHMENT_MAX_COUNT));
    } catch (error) {
      reportError(error);
      setPickError(t('feedbackAttachments.pickFailed'));
    } finally {
      if (!filesAttached) releaseStagedAttachments?.(pickedAttachments);
      pickingRef.current = false;
      setIsPicking(false);
      onPickingChange?.(false);
    }
  };

  const handleRemove = async (attachmentId: string) => {
    if (disabled || pickingRef.current) return;
    pickingRef.current = true;
    setIsPicking(true);
    onPickingChange?.(true);
    try {
      await onChange(attachments.filter((attachment) => attachment.id !== attachmentId));
    } catch (error) {
      reportError(error);
      setPickError(t('feedbackAttachments.saveFailed'));
    } finally {
      pickingRef.current = false;
      setIsPicking(false);
      onPickingChange?.(false);
    }
  };

  return (
    <View style={styles.container}>
      <View
        style={styles.strip}
        accessibilityLabel={t('feedbackAttachments.attachedCount', { count: attachments.length })}
      >
        {attachments.map((attachment) => (
          <View key={attachment.id} style={styles.tile}>
            {attachment.kind === 'image' ? (
              <Image
                source={{ uri: attachment.uri }}
                style={[styles.thumbnail, { backgroundColor: systemColors.fill }]}
                resizeMode="cover"
              />
            ) : (
              <View style={[styles.recording, { backgroundColor: systemColors.fill }]}>
                <Icon name="video" size={20} color={systemColors.secondaryLabel} />
                <Text variant="caption2" numberOfLines={2}>
                  {attachment.name}
                </Text>
                <Text variant="caption2" color={systemColors.secondaryLabel}>
                  {t('feedbackAttachments.fileSize', { size: (attachment.size / 1024 / 1024).toFixed(1) })}
                </Text>
              </View>
            )}
            <PressableSurface
              onPress={() => {
                void handleRemove(attachment.id);
              }}
              feedback="scale"
              hitSlop={8}
              disabled={disabled || isPicking}
              accessibilityRole="button"
              accessibilityLabel={t('feedbackAttachments.removeAria', { name: attachment.name })}
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
            disabled={disabled || isPicking}
            accessibilityRole="button"
            accessibilityLabel={t('feedbackAttachments.addAria')}
            style={[styles.addTile, { borderColor: systemColors.separator, backgroundColor: systemColors.fill }]}
          >
            <Icon name="plus" size={20} color={systemColors.secondaryLabel} />
            <Text variant="caption2" color={systemColors.secondaryLabel}>
              {t('screenshots.addLabel')}
            </Text>
          </PressableSurface>
        ) : null}
      </View>
      <InlineSheetError message={pickError} visible scope="feedback-media-picker" />
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {t('feedbackAttachments.publicWarning')}
      </Text>
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {t('feedbackAttachments.limits')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing[2] },
  strip: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[2] },
  tile: { width: 88, height: 88 },
  thumbnail: { width: 88, height: 88, borderRadius: borderRadius.md },
  recording: {
    width: 88,
    height: 88,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[1],
    gap: spacing[1],
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
    width: 88,
    height: 88,
    borderRadius: borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
  },
});
