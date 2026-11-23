'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOptionalBrowserSession } from '@/app/components/providers/session-provider';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { buildReportReturnPath, readReportReturnKey, stripReportParam } from './report-return-param';

/**
 * The tap on a Report a problem entry. Signed in, it opens the dialog. Signed
 * out, it opens the login modal first, the way the claim call-out does, and the
 * dialog follows a successful sign-in: at once for email and password, and
 * through `?report=` for a social sign-in that leaves the page.
 *
 * The entry points sit in pages that render the same markup for everyone (the
 * board list is in a shared CDN cache), so the session is read here, in the
 * browser. A tap that beats the session's first answer waits for it instead of
 * reading "loading" as signed out.
 *
 * `isKnownKey` says which `?report=` values this island owns; a value it does
 * not own is left for another island on the page.
 */
export function useReportRequest({
  onOpen,
  isKnownKey,
}: {
  onOpen: (key: string) => void;
  isKnownKey: (key: string) => boolean;
}): (key: string) => void {
  const { t } = useTranslation('boards');
  const status = useOptionalBrowserSession()?.status ?? 'loading';
  const { openAuthModal } = useAuthModal();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const onOpenRef = useRef(onOpen);
  const isKnownKeyRef = useRef(isKnownKey);
  const returnHandledRef = useRef(false);

  useEffect(() => {
    onOpenRef.current = onOpen;
    isKnownKeyRef.current = isKnownKey;
  }, [onOpen, isKnownKey]);

  const promptSignIn = useCallback(
    (key: string) => {
      openAuthModal({
        title: t('report.signInTitle'),
        description: t('report.signInBody'),
        callbackUrl: buildReportReturnPath(window.location.pathname, window.location.search, key),
        onSuccess: () => onOpenRef.current(key),
      });
    },
    [openAuthModal, t],
  );

  const request = useCallback(
    (key: string) => {
      if (status === 'authenticated') onOpenRef.current(key);
      else if (status === 'unauthenticated') promptSignIn(key);
      else setPendingKey(key);
    },
    [status, promptSignIn],
  );

  // A tap made before the session answered.
  useEffect(() => {
    if (pendingKey === null || status === 'loading') return;
    setPendingKey(null);
    if (status === 'authenticated') onOpenRef.current(pendingKey);
    else promptSignIn(pendingKey);
  }, [pendingKey, status, promptSignIn]);

  // Back from a social sign-in on `?report=`: reopen the dialog, then drop the
  // param. The drop waits a tick so Next's patched `replaceState` handles it
  // (see use-claim-param-strip.ts for why the native one breaks Back).
  useEffect(() => {
    if (returnHandledRef.current || status === 'loading') return;
    returnHandledRef.current = true;
    const key = readReportReturnKey(window.location.search);
    if (key === null || !isKnownKeyRef.current(key)) return;
    if (status === 'authenticated') onOpenRef.current(key);
    setTimeout(() => {
      window.history.replaceState(null, '', stripReportParam(window.location.href));
    }, 0);
  }, [status]);

  return request;
}
