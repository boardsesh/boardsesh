import { AccessibleBottomSheetTextInput as BottomSheetTextInput } from '../AccessibleBottomSheetTextInput';
import { useTypographyStyles, type TypographyScale } from '../../hooks/use-typography-styles';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
import { useCallback, useMemo, useRef, useState, type RefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter, useSegments } from 'expo-router';

import { useTranslation } from 'react-i18next';
import type { Gym } from '@boardsesh/shared-schema';
import {
  emailDomainMatchesWebsite,
  extractDomain,
  GYM_CLAIM_MESSAGE_MAX_LENGTH,
  GYM_CLAIM_SUPPORT_EMAIL,
  isGymRunByStaffError,
} from '@boardsesh/gym-claim';
import { ModalSheet } from '../ModalSheet';
import { SheetTopBar } from '../SheetTopBar';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';
import { useRequestGymClaim } from '../../lib/graphql/hooks';
import { extractGraphqlMessage } from '../../lib/graphql/extract-error-message';
import type { ManagedSheetHandle } from '../../providers/sheet-presentation-provider';
import { gymPageHref } from '../gym-page/gym-page-route';
import { useGymRouteStack } from '../gym-page/use-gym-route-stack';

type ClaimMode = 'domain' | 'admin';

type ClaimGymSheetProps = {
  sheetRef: RefObject<ManagedSheetHandle | null>;
  gym: Gym;
  /** Fired after the sheet fully dismisses. A host that mounts this per-target
   *  (the wall finder) clears its target here so the same gym can re-open later. */
  onClosed?: () => void;
  /**
   * "Check your boards" on an approved claim, run once the sheet has gone. The
   * gym's own page passes one that scrolls to its boards; every other host
   * leaves it out, and the sheet opens the gym's page in the stack it stands in.
   */
  onCheckBoards?: () => void;
};

/**
 * The ownership-claim flow, shown from the gym finder when `gym.canClaim`.
 * With a work email at the gym's website domain the backend emails a verification
 * link (`email_sent`); otherwise the claim goes to admin review (`admin_review`),
 * or lands straight away (`approved`) when an admin has turned on auto-approval
 * and the gym is an unclaimed listing.
 * A domain mismatch rejects with a GraphQL error surfaced inline. Feedback stays
 * INSIDE the sheet — toasts render behind a native modal sheet. The emailed
 * link is opened in the browser and handled by the backend, so the app does
 * nothing further after confirming an `email_sent`/`admin_review` claim. An
 * `approved` claim instead offers "Check your boards", which opens the gym's
 * page in the app: its boards with the staff actions, and Start here.
 */
export function ClaimGymSheet({ sheetRef, gym, onClosed, onCheckBoards }: ClaimGymSheetProps) {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const requestClaim = useRequestGymClaim();
  const router = useRouter();
  const segments = useSegments();
  const { gym: routeGym } = useLocalSearchParams<{ gym?: string }>();

  const domain = useMemo(() => extractDomain(gym.website), [gym.website]);
  // The server says whether the website can prove a claim: a real domain the
  // gym's OWNER put on the listing. The website alone can't tell, because a
  // synced gym's website came from public data, not from whoever runs the gym,
  // and a free provider (gmail.com, wixsite.com, …) proves nothing. Without it
  // the sheet starts in, and only offers, admin review, as the web dialog does.
  const canUseDomain = gym.canClaimByDomain === true && domain !== null;

  const [mode, setMode] = useState<ClaimMode>(canUseDomain ? 'domain' : 'admin');
  const [claimEmail, setClaimEmail] = useState('');
  const [message, setMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ status: string; email?: string | null } | null>(null);
  // Set by "Check your boards"; read once the sheet has slid away, because a
  // route pushed under a sheet still on screen lands behind it.
  const checkBoardsAfterDismiss = useRef(false);

  const resetState = useCallback(() => {
    setMode(canUseDomain ? 'domain' : 'admin');
    setClaimEmail('');
    setMessage('');
    setErrorMessage(null);
    setConfirmation(null);
    requestClaim.reset();
  }, [canUseDomain, requestClaim]);

  // The stack the sheet's own screen is registered in, not the focused route's.
  const stack = useGymRouteStack();
  // Already on this gym's page (a report sheet's claim nudge there): the page
  // refreshes into its staff view on its own, so pushing it again would stack a copy.
  const onThisGymsPage =
    segments[segments.length - 1] === '[gym]' && (routeGym === gym.uuid || (!!gym.slug && routeGym === gym.slug));
  const handleFullyDismissed = useCallback(() => {
    const checkBoards = checkBoardsAfterDismiss.current;
    checkBoardsAfterDismiss.current = false;
    resetState();
    onClosed?.();
    if (!checkBoards) return;
    if (onCheckBoards) onCheckBoards();
    else if (!onThisGymsPage) router.push(gymPageHref(gym.uuid, stack));
  }, [resetState, onClosed, onCheckBoards, onThisGymsPage, router, gym.uuid, stack]);

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
        // A gym its staff run can't be claimed: say so in the climber's language,
        // not the server's English.
        setErrorMessage(
          isGymRunByStaffError(error)
            ? t('mobile.gymClaim.errorRunByStaff')
            : (extractGraphqlMessage(error) ?? t('mobile.gymClaim.errorGeneric')),
        );
      }
    },
    [requestClaim, gym.uuid, t],
  );

  const submitDomainClaim = useCallback(() => {
    // Checked here so the mismatch reads in the app's language, not the
    // backend's English.
    if (!emailDomainMatchesWebsite(trimmedEmail, gym.website)) {
      setErrorMessage(t('mobile.gymClaim.domain.mismatch', { domain: domain ?? '' }));
      return;
    }
    void submit({ claimEmail: trimmedEmail });
  }, [trimmedEmail, gym.website, domain, submit, t]);

  const switchMode = useCallback((next: ClaimMode) => {
    setErrorMessage(null);
    setMode(next);
  }, []);

  const checkBoards = useCallback(() => {
    checkBoardsAfterDismiss.current = true;
    dismiss();
  }, [dismiss]);

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

  const inDomainForm = !confirmation && mode === 'domain' && canUseDomain && Boolean(domain);
  const header = (
    <SheetTopBar
      title={t('mobile.gymClaim.title', { gym: gym.name })}
      leading={confirmation ? undefined : { kind: 'cancel', onPress: dismiss }}
      trailing={
        confirmation
          ? { kind: 'forward', label: t('mobile.gymClaim.done'), onPress: dismiss, prominent: true }
          : inDomainForm
            ? {
                kind: 'send',
                label: t('mobile.gymClaim.domain.submitShort'),
                accessibilityLabel: t('mobile.gymClaim.domain.submit'),
                onPress: submitDomainClaim,
                disabled: !canSubmitDomain || requestClaim.isPending,
                loading: requestClaim.isPending,
                prominent: true,
              }
            : {
                kind: 'send',
                label: t('mobile.gymClaim.admin.submitShort'),
                accessibilityLabel: t('mobile.gymClaim.admin.submit'),
                onPress: () => void submit({ message: message.trim() || undefined }),
                disabled: requestClaim.isPending,
                loading: requestClaim.isPending,
                prominent: true,
              }
      }
      error={confirmation ? null : errorMessage}
      reserveErrorSlot
    />
  );

  return (
    <ModalSheet
      ref={sheetRef}
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      scrollable
      contentContainerStyle={styles.content}
      onFullyDismissed={handleFullyDismissed}
      header={header}
    >
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
            <Button title={t('mobile.gymClaim.approved.manageCta')} onPress={checkBoards} variant="filled" />
          ) : null}
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
          {canUseDomain ? (
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

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    content: {
      paddingHorizontal: spacing[4],
      paddingTop: spacing[4],
      paddingBottom: spacing[6],
      gap: spacing[3],
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
      fontSize: textStyles.callout.fontSize,
    },
    multiline: {
      minHeight: 96,
      maxHeight: 200,
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
