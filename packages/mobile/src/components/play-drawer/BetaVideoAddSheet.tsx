import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, TextInput, Pressable, KeyboardAvoidingView, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import type BottomSheet from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import { isBetaVideoUrl, isInstagramUrl, isTikTokUrl } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../lib/analytics';
import { Sheet } from '../Sheet';
import { Text } from '../Text';
import { useAttachBetaLink } from '../../lib/graphql/hooks';
import { extractGraphqlMessage } from '../../lib/graphql/extract-error-message';
import { useToast } from '../../providers/toast-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { brandColors } from '../../theme/colors';
import { spacing, borderRadius } from '../../theme/tokens';

export type BetaVideoAddSheetHandle = {
  open: () => void;
  close: () => void;
};

type Props = {
  boardName: string;
  climbUuid: string;
  angle: number;
};

export const BetaVideoAddSheet = forwardRef<BetaVideoAddSheetHandle, Props>(function BetaVideoAddSheet(
  { boardName, climbUuid, angle },
  ref,
) {
  const { t } = useTranslation('session');
  const { showToast } = useToast();
  const bottomSheetRef = useRef<BottomSheet>(null);
  const inputRef = useRef<TextInput>(null);
  const [url, setUrl] = useState('');

  const attach = useAttachBetaLink();

  useImperativeHandle(ref, () => ({
    open: () => bottomSheetRef.current?.snapToIndex(0),
    close: () => bottomSheetRef.current?.close(),
  }));

  const handleSheetChange = useCallback((index: number) => {
    if (index >= 0) inputRef.current?.focus();
  }, []);

  const trimmed = url.trim();
  const hasInput = trimmed.length > 0;
  const isValid = hasInput && isBetaVideoUrl(trimmed);
  // Don't shout at the user before they've typed anything; only surface the
  // validation hint once they've entered something that fails the pattern.
  const showError = hasInput && !isValid;

  const handleClose = useCallback(() => {
    setUrl('');
  }, []);

  const handleSubmit = useCallback(() => {
    if (!isValid || attach.isPending) return;
    attach.mutate(
      { boardType: boardName, climbUuid, link: trimmed, angle },
      {
        onSuccess: () => {
          // Match web's attach-beta-link-form `Beta Video Added` props exactly
          // (boardType, climbUuid, platform) so both platforms aggregate.
          let platform: 'TikTok' | 'Instagram' | 'Unknown' = 'Unknown';
          if (isTikTokUrl(trimmed)) platform = 'TikTok';
          else if (isInstagramUrl(trimmed)) platform = 'Instagram';
          track(SHARED_EVENTS.BetaVideoAdded, { boardType: boardName, climbUuid, platform });
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          showToast(t('mobile.betaVideos.attachSuccess'), 'success');
          setUrl('');
          bottomSheetRef.current?.close();
        },
        onError: (error: unknown) => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          const message = extractGraphqlMessage(error) ?? t('mobile.betaVideos.attachError');
          showToast(message, 'error');
        },
      },
    );
  }, [angle, attach, boardName, climbUuid, isValid, showToast, t, trimmed]);

  const snapPoints = useMemo(() => ['40%'], []);

  return (
    <Sheet ref={bottomSheetRef} snapPoints={snapPoints} onChange={handleSheetChange} onClose={handleClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
      >
        <View style={styles.container}>
          <Text variant="title3" style={styles.title}>
            {t('mobile.betaVideos.addTitle')}
          </Text>

          <TextInput
            ref={inputRef}
            value={url}
            onChangeText={setUrl}
            placeholder={t('mobile.betaVideos.urlPlaceholder')}
            placeholderTextColor={iosSystemColors.systemGray}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="send"
            onSubmitEditing={handleSubmit}
            style={styles.input}
          />

          {showError && (
            <Text variant="footnote" color={iosSystemColors.systemRed} style={styles.errorText}>
              {t('mobile.betaVideos.urlInvalid')}
            </Text>
          )}

          <Pressable
            onPress={handleSubmit}
            disabled={!isValid || attach.isPending}
            accessibilityRole="button"
            accessibilityState={{ disabled: !isValid || attach.isPending }}
            style={({ pressed }) => [
              styles.submitButton,
              (!isValid || attach.isPending) && styles.submitButtonDisabled,
              pressed && !(!isValid || attach.isPending) && styles.submitButtonPressed,
            ]}
          >
            <Text variant="headline" color={iosSystemColors.white}>
              {attach.isPending ? t('mobile.betaVideos.submitting') : t('mobile.betaVideos.submitButton')}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Sheet>
  );
});

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[6],
    gap: spacing[3],
  },
  title: {
    marginBottom: spacing[1],
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: iosSystemColors.separator,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    fontSize: 16,
    color: iosSystemColors.systemGray,
  },
  errorText: {
    marginTop: -spacing[2],
  },
  submitButton: {
    backgroundColor: brandColors.primary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing[3],
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitButtonPressed: {
    opacity: 0.85,
  },
});
