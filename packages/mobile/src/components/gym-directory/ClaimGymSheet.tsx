import { useCallback, useMemo, useState, type RefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { Gym } from '@boardsesh/shared-schema';
import { extractDomain, GYM_CLAIM_MESSAGE_MAX_LENGTH, GYM_CLAIM_SUPPORT_EMAIL } from '@boardsesh/gym-claim';
import { ModalSheet } from '../ModalSheet';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { useRequestGymClaim } from '../../lib/graphql/hooks';
import { extractGraphqlMessage } from '../../lib/graphql/extract-error-message';
import { openValidatedUrl } from '../../lib/open-external-link';
import { WEB_BASE_URL } from '../../lib/env';
import { buildGymManageUrl } from '../../lib/gym-manage-url';
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
 * link (`email_sent`); otherwise the claim goes to admin review (`admin_review`),
 * or lands straight away (`approved`) when an admin has turned on auto-approval
 * and the gym is an unclaimed listing.
 * A domain mismatch rejects with a GraphQL error surfaced inline. Feedback stays
 * INSIDE the sheet — toasts render behind a native modal sheet. The emailed
 * link is opened in the browser and handled by the backend, so the app does
 * nothing further after confirming an `email_sent`/`admin_review` claim. An
 * `approved` claim instead offers a "Manage gym" hand-off to the web setup
 * console, mirroring MyGymsScreen's kiosk hand-off and the web claim dialog.
 */
export function ClaimGymSheet({ sheetRef, gym, onClosed }: ClaimGymSheetProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const requestClaim = useRequestGymClaim();

  // Display only: the domain printed in the copy and the placeholder.
  const domain = useMemo(() => extractDomain(gym.website), [gym.website]);
  // Which claim path can actually succeed, decided by the server. It is both
  // halves of the rule requestGymClaim enforces: the website is a real
  // (non-free-provider) domain — anyone can get a gmail.com/wixsite.com address —
  // AND the gym's own owner put it there. This sheet used to derive only the
  // first half from `gym.website`, so an un-vouched gym with a corporate-looking
  // website opened the email form and the climber only heard "no" after
  // submitting (#4018).
  const canClaimByDomain = gym.canClaimByDomain;

  const [mode, setMode] = useState<ClaimMode>(canClaimByDomain ? 'domain' : 'admin');
  const [claimEmail, setClaimEmail] = useState('');
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ status: string; email?: string | null } | null>(null);
  // Separate from `errorMessage` (pre-submission form validation) so resetting
  // one never accidentally clears feedback that belongs to the other.
  const [manageError, setManageError] = useState<string | null>(null);

  const resetState = useCallback(() => {
    setMode(canClaimByDomain ? 'domain' : 'admin');
    setClaimEmail('');
    setMessage('');
    setErrorMessage(null);
    setConfirmation(null);
    setManageError(null);
    requestClaim.reset();
  }, [canClaimByDomain, requestClaim]);

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

  // Same web hand-off pattern as MyGymsScreen's manageKiosks: kiosk/setup
  // management is web-only by design. `gym.uuid` is always present, so a
  // slugless gym still reaches setup via its uuid.
  const openManageGym = useCallback(async () => {
    setManageError(null);
    const slugOrUuid = gym.slug ?? gym.uuid;
    const opened = await openValidatedUrl(buildGymManageUrl(slugOrUuid), (url) => url.startsWith(WEB_BASE_URL));
    if (opened) {
      dismiss();
    } else {
      // Inline, not a toast -- toasts render behind this native modal sheet
      // (see the sheet-level doc comment above).
      setManageError(t('mobile.gymClaim.approved.manageError'));
    }
  }, [gym.slug, gym.uuid, dismiss, t]);

  // The same two promises the web dialog makes, in the same place: what taking
  // the listing protects, and where an ownership handover goes. Both form modes
  // show them; the confirmation doesn't — by then the terms are agreed.
  const protections = (
    <View style={styles.protections}>
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {t('mobile.gymClaim.protections.syncFreeze')}
      </Text>
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {t('mobile.gymClaim.protections.transfer', { email: GYM_CLAIM_SUPPORT_EMAIL })}
      </Text>
    </View>
  );

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
              : confirmation.status === 'approved'
                ? t('mobile.gymClaim.approved.sent', { gym: gym.name })
                : t('mobile.gymClaim.admin.sent')}
          </Text>
          {confirmation.status === 'approved' ? (
            <Button
              title={t('mobile.gymClaim.approved.manageCta')}
              onPress={() => void openManageGym()}
              variant="filled"
              size="large"
            />
          ) : null}
          {manageError ? (
            <Text variant="footnote" color={brandColors.error} style={styles.errorText}>
              {manageError}
            </Text>
          ) : null}
          <Button
            title={t('mobile.gymClaim.done')}
            onPress={dismiss}
            variant={confirmation.status === 'approved' ? 'text' : 'filled'}
            size="large"
          />
        </View>
      ) : mode === 'domain' && canClaimByDomain && domain ? (
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
          {protections}
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
          {canClaimByDomain ? (
            <Button
              title={t('mobile.gymClaim.switchToDomain')}
              onPress={() => switchMode('domain')}
              variant="text"
              size="medium"
              tintColor={brandColors.primary}
            />
          ) : null}
          {protections}
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
  protections: {
    gap: spacing[2],
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
