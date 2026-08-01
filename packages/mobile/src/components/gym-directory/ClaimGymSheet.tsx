import { useCallback, useMemo, useState, type RefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { Gym } from '@boardsesh/shared-schema';
import { extractDomain, isClaimableDomain, GYM_CLAIM_MESSAGE_MAX_LENGTH } from '@boardsesh/gym-claim';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { useRequestGymClaim } from '../../lib/graphql/hooks';
import { extractGraphqlMessage } from '../../lib/graphql/extract-error-message';
import type { ManagedSheetHandle } from '../../providers/sheet-presentation-provider';

type ClaimMode = 'domain' | 'admin';

type ClaimGymSheetProps = {
  sheetRef: RefObject<ManagedSheetHandle | null>;
  gym: Gym;
  /** Fired after the sheet fully dismisses. A host that mounts this per-target
   *  (the wall finder) clears its target here so the same gym can re-open later. */
  onClosed?: () => void;
};

/**
 * The ownership-claim flow, shown from the gym-edit screen when `gym.canClaim`.
 * With a work email at the gym's website domain the backend emails a verification
 * link (`email_sent`); otherwise the claim goes to admin review (`admin_review`).
 * A domain mismatch rejects with a GraphQL error surfaced inline. Feedback stays
 * INSIDE the sheet — toasts render behind a native modal sheet — and the emailed
 * link is opened in the browser and handled by the backend, so the app does
 * nothing further after confirming.
 */
export function ClaimGymSheet({ sheetRef, gym, onClosed }: ClaimGymSheetProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const requestClaim = useRequestGymClaim();

  const domain = useMemo(() => extractDomain(gym.website), [gym.website]);
  // A gym with a free/consumer-provider website (gmail.com, wixsite.com, …) can't
  // be domain-proof claimed — anyone can get such an address — so start in and
  // only offer admin review for those, matching the web dialog and the backend.
  const canUseDomain = useMemo(() => isClaimableDomain(gym.website), [gym.website]);

  const [mode, setMode] = useState<ClaimMode>(canUseDomain ? 'domain' : 'admin');
  const [claimEmail, setClaimEmail] = useState('');
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ status: string; email?: string | null } | null>(null);

  const resetState = useCallback(() => {
    setMode(canUseDomain ? 'domain' : 'admin');
    setClaimEmail('');
    setMessage('');
    setErrorMessage(null);
    setConfirmation(null);
    requestClaim.reset();
  }, [canUseDomain, requestClaim]);

  const handleFullyDismissed = useCallback(() => {
    resetState();
    onClosed?.();
  }, [resetState, onClosed]);

  const dismiss = useCallback(() => sheetRef.current?.dismiss(), [sheetRef]);

  const trimmedEmail = claimEmail.trim();
  const canSubmitDomain = trimmedEmail.length > 3 && trimmedEmail.includes('@');

  const submit = useCallback(
    async (input: { claimEmail?: string; message?: string }) => {
      setErrorMessage(null);
      try {
        const result = await requestClaim.mutateAsync({ gymUuid: gym.uuid, ...input });
        setConfirmation({ status: result.status, email: result.email });
      } catch (error) {
        setErrorMessage(extractGraphqlMessage(error) ?? t('mobile.gymClaim.errorGeneric'));
      }
    },
    [requestClaim, gym.uuid, t],
  );

  const switchMode = useCallback((next: ClaimMode) => {
    setErrorMessage(null);
    setMode(next);
  }, []);

  return (
    <ModalSheet
      ref={sheetRef}
      snapPoints={['58%', '88%']}
      scrollable
      contentContainerStyle={styles.content}
      onFullyDismissed={handleFullyDismissed}
    >
      <View style={styles.headerRow}>
        <Text variant="title3" style={styles.title}>
          {t('mobile.gymClaim.title', { gym: gym.name })}
        </Text>
        <PressableSurface
          onPress={dismiss}
          feedback="opacity"
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.gymClaim.close')}
          style={styles.closeButton}
        >
          <Icon name="close" size={20} color={systemColors.secondaryLabel} />
        </PressableSurface>
      </View>

      {confirmation ? (
        <View style={styles.confirmation}>
          <Icon name="checkmark.circle.fill" size={44} color={brandColors.success} />
          <Text variant="headline" style={styles.confirmationTitle}>
            {confirmation.status === 'email_sent'
              ? t('mobile.gymClaim.domain.sent', { email: confirmation.email ?? trimmedEmail })
              : t('mobile.gymClaim.admin.sent')}
          </Text>
          <Button title={t('mobile.gymClaim.done')} onPress={dismiss} variant="filled" size="large" />
        </View>
      ) : mode === 'domain' && canUseDomain && domain ? (
        <>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.description}>
            {t('mobile.gymClaim.domain.description', { gym: gym.name, domain })}
          </Text>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.fieldLabel}>
            {t('mobile.gymClaim.domain.emailLabel')}
          </Text>
          <BottomSheetTextInput
            style={[
              styles.input,
              { backgroundColor: systemColors.fill, borderColor: systemColors.separator, color: systemColors.label },
            ]}
            placeholder={t('mobile.gymClaim.domain.emailPlaceholder', { domain })}
            placeholderTextColor={systemColors.tertiaryLabel}
            value={claimEmail}
            onChangeText={(value) => {
              setClaimEmail(value);
              if (errorMessage) setErrorMessage(null);
            }}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={200}
          />
          {errorMessage ? (
            <Text variant="footnote" color={brandColors.error} style={styles.errorText}>
              {errorMessage}
            </Text>
          ) : null}
          <Button
            title={t('mobile.gymClaim.domain.submit')}
            onPress={() => void submit({ claimEmail: trimmedEmail })}
            variant="filled"
            size="large"
            disabled={!canSubmitDomain || requestClaim.isPending}
            loading={requestClaim.isPending}
            style={styles.submitButton}
          />
          <Button
            title={t('mobile.gymClaim.switchToAdmin')}
            onPress={() => switchMode('admin')}
            variant="text"
            size="medium"
            tintColor={brandColors.primary}
          />
        </>
      ) : (
        <>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.description}>
            {t('mobile.gymClaim.admin.description', { gym: gym.name })}
          </Text>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.fieldLabel}>
            {t('mobile.gymClaim.admin.messageLabel')}
          </Text>
          <BottomSheetTextInput
            style={[
              styles.input,
              styles.multiline,
              { backgroundColor: systemColors.fill, borderColor: systemColors.separator, color: systemColors.label },
            ]}
            placeholder={t('mobile.gymClaim.admin.messagePlaceholder')}
            placeholderTextColor={systemColors.tertiaryLabel}
            value={message}
            onChangeText={(value) => {
              setMessage(value);
              if (errorMessage) setErrorMessage(null);
            }}
            multiline
            maxLength={GYM_CLAIM_MESSAGE_MAX_LENGTH}
            textAlignVertical="top"
          />
          {errorMessage ? (
            <Text variant="footnote" color={brandColors.error} style={styles.errorText}>
              {errorMessage}
            </Text>
          ) : null}
          <Button
            title={t('mobile.gymClaim.admin.submit')}
            onPress={() => void submit({ message: message.trim() || undefined })}
            variant="filled"
            size="large"
            disabled={requestClaim.isPending}
            loading={requestClaim.isPending}
            style={styles.submitButton}
          />
          {canUseDomain ? (
            <Button
              title={t('mobile.gymClaim.switchToDomain')}
              onPress={() => switchMode('domain')}
              variant="text"
              size="medium"
              tintColor={brandColors.primary}
            />
          ) : null}
        </>
      )}
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[6],
    gap: spacing[3],
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
  },
  title: {
    flex: 1,
    fontWeight: '700',
  },
  closeButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  description: {
    marginTop: -spacing[1],
  },
  fieldLabel: {
    textTransform: 'uppercase',
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    fontSize: 16,
  },
  multiline: {
    minHeight: 96,
    maxHeight: 200,
  },
  errorText: {
    marginTop: -spacing[1],
  },
  submitButton: {
    marginTop: spacing[1],
  },
  confirmation: {
    alignItems: 'center',
    gap: spacing[3],
    paddingVertical: spacing[6],
  },
  confirmationTitle: {
    textAlign: 'center',
  },
});
