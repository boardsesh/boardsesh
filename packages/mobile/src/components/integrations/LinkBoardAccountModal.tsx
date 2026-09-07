import { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, StyleSheet, TextInput, View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { boardTypeLabel } from '@boardsesh/board-constants';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { Button } from '../Button';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
import {
  AURORA_CREDENTIALS_QUERY_KEY,
  AURORA_UNSYNCED_QUERY_KEY,
} from '../../lib/integrations/use-board-account-credentials';
import { BoardAccountError, saveAuroraCredential, saveKilterCredentialViaPassword } from '../../lib/aurora-credentials';
import {
  trackLinkFailed,
  trackLinkStarted,
  trackLinkSucceeded,
  type BoardLinkFailureReason,
  type BoardLinkSource,
} from '../../lib/integrations/board-link-analytics';

// Kilter uses its password grant; other boards use the Aurora credential endpoint.
async function saveBoardCredential(input: { boardType: AuroraBoardName; username: string; password: string }) {
  if (input.boardType === 'kilter') {
    await saveKilterCredentialViaPassword({ username: input.username, password: input.password });
    return null;
  }
  return saveAuroraCredential(input);
}

function failureReasonFor(error: unknown): BoardLinkFailureReason {
  return error instanceof BoardAccountError ? error.code : 'request_failed';
}

export function errorMessageFor(error: unknown, t: TFunction<'settings'>): string {
  if (error instanceof BoardAccountError) {
    switch (error.code) {
      case 'account_already_linked':
        return t('aurora.linkDialog.accountAlreadyLinked');
      case 'invalid_credentials':
        return t('aurora.mobile.invalidCredentials');
      case 'not_allowed':
        return t('aurora.mobile.kilterNotAllowed');
      case 'rate_limited':
        return t('aurora.mobile.rateLimited');
      case 'request_failed':
      case 'unauthorized':
        return t('aurora.mobile.requestFailed');
    }
  }
  return t('aurora.mobile.requestFailed');
}

type LinkBoardAccountModalProps = {
  /** Which board to sign in to. `null` closes the dialog. */
  boardType: AuroraBoardName | null;
  /** Which surface offered the link, for the funnel. */
  source: BoardLinkSource;
  onClose: () => void;
  /** Fired after a successful link, once the credential caches are invalidated. */
  onLinked?: (boardType: AuroraBoardName) => void;
};

/** Shared credential form with request, feedback and funnel reporting. */
export function LinkBoardAccountModal({ boardType, source, onClose, onLinked }: LinkBoardAccountModalProps) {
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, colorScheme } = useTheme();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // A new board or a closed dialog clears credentials.
  useEffect(() => {
    setUsername('');
    setPassword('');
  }, [boardType]);

  const saveCredentialMutation = useMutation({
    mutationFn: saveBoardCredential,
    onSuccess: async (_credential, variables) => {
      trackLinkSucceeded({ boardType: variables.boardType, source });
      showToast(t('aurora.mobile.linkSuccess', { boardName: boardTypeLabel(variables.boardType) }), 'success');
      onClose();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: AURORA_CREDENTIALS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: AURORA_UNSYNCED_QUERY_KEY }),
      ]);
      onLinked?.(variables.boardType);
    },
    onError: (error, variables) => {
      trackLinkFailed({ boardType: variables.boardType, source }, failureReasonFor(error));
      showToast(errorMessageFor(error, t), 'error');
    },
  });

  const handleSubmit = useCallback(() => {
    if (!boardType) return;
    trackLinkStarted({ boardType, source });
    saveCredentialMutation.mutate({ boardType, username: username.trim(), password });
  }, [boardType, password, saveCredentialMutation, source, username]);

  const inputBackground = colorScheme === 'dark' ? iosSystemColors.white : '#FFFFFF';
  const inputBorder = colorScheme === 'dark' ? 'rgba(60, 60, 67, 0.36)' : 'rgba(60, 60, 67, 0.18)';
  const inputStyle = [styles.input, { backgroundColor: inputBackground, borderColor: inputBorder, color: '#000000' }];

  const isKilter = boardType === 'kilter';
  const boardName = boardType ? boardTypeLabel(boardType) : '';

  return (
    <Modal visible={boardType !== null} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalBackdrop}>
        <View style={[styles.modalCard, { backgroundColor: systemColors.secondaryBackground }]}>
          <Text variant="headline" style={styles.modalTitle}>
            {isKilter ? t('aurora.kilterLinkDialog.title') : t('aurora.linkDialog.title', { boardName })}
          </Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.modalCopy}>
            {isKilter ? t('aurora.kilterLinkDialog.description') : t('aurora.linkDialog.description', { boardName })}
          </Text>
          <TextInput
            value={username}
            onChangeText={setUsername}
            placeholder={t('aurora.linkDialog.usernamePlaceholder')}
            placeholderTextColor="rgba(60, 60, 67, 0.6)"
            autoCapitalize="none"
            autoCorrect={false}
            style={inputStyle}
          />
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder={t('aurora.linkDialog.passwordPlaceholder')}
            placeholderTextColor="rgba(60, 60, 67, 0.6)"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={inputStyle}
          />
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {isKilter ? t('aurora.kilterLinkDialog.passwordHelp') : t('aurora.mobile.passwordHelp')}
          </Text>
          <View style={styles.modalActions}>
            <Button title={tCommon('actions.cancel')} variant="text" role="cancel" onPress={onClose} />
            <Button
              title={t('aurora.linkDialog.submit')}
              onPress={handleSubmit}
              loading={saveCredentialMutation.isPending}
              disabled={username.trim().length === 0 || password.length === 0 || saveCredentialMutation.isPending}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[4],
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: borderRadius.lg,
    padding: spacing[4],
    gap: spacing[3],
  },
  modalTitle: { fontWeight: '700' },
  modalCopy: { lineHeight: 20 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: borderRadius.md,
    minHeight: 48,
    paddingHorizontal: spacing[3],
    fontSize: 16,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing[2],
    marginTop: spacing[2],
  },
});
