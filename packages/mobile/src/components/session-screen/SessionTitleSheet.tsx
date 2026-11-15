import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { SessionDetail } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { SessionPreview } from '../../lib/graphql/operations';
import { useUpdateSession } from '../../lib/graphql/hooks';
import { track } from '../../lib/analytics';
import { hapticSuccess } from '../../lib/haptics';
import { SessionTitleSheetView } from './SessionTitleSheetView';

type SessionTitleSheetProps = {
  /** Controlled visibility. */
  visible: boolean;
  /** The session being renamed; null disables the save. */
  sessionId: string | null;
  /** The session's current title (server value), used to seed the input on open. */
  currentName?: string | null;
  onClose: () => void;
};

/**
 * Rename the active session from the Record screen. One single-line input seeded
 * from the current title on each closed→open transition. Saving writes the new
 * name through the creator-only `updateSession` mutation (an empty value clears
 * it back to the default "Session" title), optimistically patches the
 * `sessionDetail` cache so the chrome updates instantly (the 30s staleTime would
 * otherwise leave the old title on screen), and closes. Failures surface inline —
 * a toast would render behind the native sheet.
 */
export function SessionTitleSheet({ visible, sessionId, currentName, onClose }: SessionTitleSheetProps) {
  const { t } = useTranslation('session');
  const queryClient = useQueryClient();
  const updateSession = useUpdateSession();

  const [name, setName] = useState('');

  // Seed the field from the current title each time the sheet opens; the Sheet is
  // driven declaratively off `visible`, so track only the closed→open transition.
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      setName(currentName ?? '');
      updateSession.reset();
    }
    wasVisibleRef.current = visible;
  }, [visible, currentName, updateSession]);

  const handleChange = useCallback(
    (text: string) => {
      if (updateSession.isError) updateSession.reset();
      setName(text);
    },
    [updateSession],
  );

  const handleSave = useCallback(() => {
    if (!sessionId) return;
    const trimmed = name.trim();
    updateSession.mutate(
      { input: { sessionId, name: trimmed.length > 0 ? trimmed : null } },
      {
        onSuccess: (updated) => {
          // The chrome reads the title from the sessionPreview cache first
          // (sessionDetail is null until the first tick), falling back to
          // sessionDetail. Patch both in place so the header flips immediately
          // instead of waiting out their staleTimes.
          queryClient.setQueryData<SessionPreview | null>(['sessionPreview', sessionId], (prev) =>
            prev ? { ...prev, name: updated.name ?? null } : prev,
          );
          queryClient.setQueryData<SessionDetail>(['sessionDetail', sessionId], (prev) =>
            prev ? { ...prev, sessionName: updated.name } : prev,
          );
          hapticSuccess();
          track(SHARED_EVENTS.SessionRenamed, { source: 'record_chrome', nameLength: trimmed.length });
          onClose();
        },
      },
    );
  }, [sessionId, name, updateSession, queryClient, onClose]);

  return (
    <SessionTitleSheetView
      visible={visible}
      name={name}
      isPending={updateSession.isPending}
      saveDisabled={!sessionId}
      errorMessage={
        updateSession.isError
          ? updateSession.error instanceof Error && updateSession.error.message.includes('creator')
            ? t('mobile.session.renameNotAllowed')
            : t('mobile.session.renameError')
          : null
      }
      onChangeName={handleChange}
      onSave={handleSave}
      onClose={onClose}
    />
  );
}
