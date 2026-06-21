import { useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View, type ColorValue } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ClientError } from 'graphql-request';
import { useTheme } from '../providers/theme-provider';
import { useToast } from '../providers/toast-provider';
import { useAuth } from '../providers/auth-provider';
import { useDeleteAccount, useDeleteAccountInfo } from '../lib/graphql/hooks';
import { borderRadius, spacing } from '../theme/tokens';
import { reportError } from '../lib/error-reporting';
import { Text, type TextVariant } from './Text';
import { SwitchRow } from './SwitchRow';
import { Button } from './Button';

const CONFIRM_PHRASE = 'DELETE';

/**
 * Renders a translation string that contains `<strong>…</strong>` emphasis
 * (e.g. `deleteAccount.dialog.confirmInstruction`) natively in React Native.
 * Web uses react-i18next's `<Trans>` for this; mobile has no `<Trans>` usage,
 * so we split on the tag and bold the captured segment. Splitting on a
 * capturing group puts the emphasised text at the odd indices.
 */
function EmphasizedText({
  text,
  variant = 'body',
  color,
}: {
  text: string;
  variant?: TextVariant;
  color?: ColorValue;
}) {
  const segments = text.split(/<strong>(.*?)<\/strong>/g);
  return (
    <Text variant={variant} color={color}>
      {segments.map((segment, index) =>
        index % 2 === 1 ? (
          <Text key={index} variant={variant} color={color} style={styles.bold}>
            {segment}
          </Text>
        ) : (
          segment
        ),
      )}
    </Text>
  );
}

export function DeleteAccountScreen() {
  const { t } = useTranslation('settings');
  const { systemColors, brandColors } = useTheme();
  const { showToast } = useToast();
  const { signOut } = useAuth();
  const router = useRouter();

  const [confirmText, setConfirmText] = useState('');
  const [removeSetterName, setRemoveSetterName] = useState(false);
  // Held true through the post-mutation signOut too, so the buttons stay
  // disabled until the auth provider unmounts this screen (redirect to login).
  const [isDeleting, setIsDeleting] = useState(false);

  const infoQuery = useDeleteAccountInfo();
  const deleteAccount = useDeleteAccount();

  // On a failed info fetch, `data` is undefined → treat as no published climbs
  // (hide the setter-name option) but still allow deletion, matching web.
  const publishedClimbCount = infoQuery.data ?? 0;
  const hasPublishedClimbs = publishedClimbCount > 0;
  const isConfirmed = confirmText === CONFIRM_PHRASE;

  const handleDelete = async () => {
    // Block until the climb-info fetch settles: while it's loading,
    // publishedClimbCount reads as 0, so the setter-name option is hidden. Letting
    // the delete through here would submit removeSetterName:false and leave the
    // setter name on preserved climbs without the user ever seeing the choice.
    if (!isConfirmed || isDeleting || infoQuery.isLoading) return;
    let accountDeleted = false;
    try {
      setIsDeleting(true);
      await deleteAccount.mutateAsync({ input: { removeSetterName } });
      accountDeleted = true;
      // Account gone — sign out. The auth provider clears local state and flips
      // isAuthenticated → false, which redirects to /auth/login (no manual nav).
      // signOut's revoke is best-effort, so this resolves even though the
      // session was just deleted server-side.
      await signOut('account_deleted');
    } catch (error) {
      reportError(error);
      // The account is already gone; only the local sign-out cleanup failed.
      // Showing a "deletion failed" toast or re-enabling the form would be
      // misleading — a now-stale token will 401 and the interceptor's forced
      // sign-out redirects to login. Distinguish this from a real (pre-mutation)
      // deletion failure, which should surface the error and let the user retry.
      if (accountDeleted) return;
      let message = t('deleteAccount.error');
      if (error instanceof ClientError) {
        const serverMessage = error.response?.errors?.[0]?.message;
        if (serverMessage) message = serverMessage;
      }
      showToast(message, 'error');
      setIsDeleting(false);
    }
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
        <Text variant="body" color={systemColors.secondaryLabel}>
          {t('deleteAccount.dialog.warning')}
        </Text>
      </View>

      {infoQuery.isLoading ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.checking}>
          {t('deleteAccount.dialog.checking')}
        </Text>
      ) : null}

      {hasPublishedClimbs ? (
        <View style={styles.section}>
          <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
            <EmphasizedText
              text={t('deleteAccount.dialog.publishedClimbs', { count: publishedClimbCount })}
              variant="body"
              color={systemColors.label}
            />
          </View>
          <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
            <SwitchRow
              label={t('deleteAccount.dialog.removeSetterName')}
              value={removeSetterName}
              onValueChange={setRemoveSetterName}
              disabled={isDeleting}
            />
          </View>
        </View>
      ) : null}

      <View style={styles.confirmBlock}>
        <EmphasizedText text={t('deleteAccount.dialog.confirmInstruction')} variant="body" color={systemColors.label} />
        <TextInput
          autoCapitalize="characters"
          autoCorrect={false}
          editable={!isDeleting}
          value={confirmText}
          onChangeText={setConfirmText}
          placeholder={t('deleteAccount.dialog.confirmPlaceholder')}
          placeholderTextColor={systemColors.tertiaryLabel}
          accessibilityLabel={t('deleteAccount.dialog.confirmPlaceholder')}
          style={[
            styles.input,
            {
              color: systemColors.label,
              backgroundColor: systemColors.tertiaryBackground,
              borderColor: systemColors.separator,
            },
          ]}
        />
      </View>

      <View style={styles.actions}>
        <Button
          title={t('deleteAccount.dialog.confirm')}
          variant="filled"
          tintColor={brandColors.error}
          onPress={() => {
            void handleDelete();
          }}
          disabled={!isConfirmed || isDeleting || infoQuery.isLoading}
          loading={isDeleting}
        />
        <Button
          title={t('deleteAccount.dialog.cancel')}
          variant="text"
          onPress={() => router.back()}
          disabled={isDeleting}
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
  card: {
    overflow: 'hidden',
    borderRadius: borderRadius.lg,
    marginHorizontal: spacing[4],
    padding: spacing[4],
  },
  section: {
    gap: spacing[3],
    marginTop: spacing[5],
  },
  checking: {
    marginHorizontal: spacing[4],
    marginTop: spacing[3],
  },
  confirmBlock: {
    marginHorizontal: spacing[4],
    marginTop: spacing[5],
    gap: spacing[2],
  },
  input: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    borderRadius: borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
  },
  actions: {
    marginHorizontal: spacing[4],
    marginTop: spacing[6],
    gap: spacing[2],
  },
  bold: {
    fontWeight: '700',
  },
});
