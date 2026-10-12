import { useEffect, useRef, type ReactNode } from 'react';
import { useRouter, useSegments } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useConsentSettled } from '../lib/consent-hooks';
import { reportHandledError } from '../lib/error-reporting';
import { useAuth } from './auth-provider';
import { useToast } from './toast-provider';
import { useLaunchReady } from './launch-ready-context';
import { useShareReceipt } from './share-receipt-provider';

export { extractSharedLink } from '../lib/shared-link';

/** Routes durable receipts only after auth, privacy choice, and launch settle. */
export function ShareTargetProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const segments = useSegments();
  const { isAuthenticated } = useAuth();
  const consentSettled = useConsentSettled();
  const launchReady = useLaunchReady();
  const { draft, pendingLink, destination, revision, consumeLink, consumeBugNavigation, notice, clearNotice } =
    useShareReceipt();
  const { t } = useTranslation('common');
  const { t: tSession } = useTranslation('session');
  const { showToast } = useToast();
  const handledNavigation = useRef<string | null>(null);
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  useEffect(() => {
    if (!isAuthenticated || !consentSettled || !launchReady || !destination) return;
    const navigationKey = `${destination}:${revision}:${destination === 'bug' ? draft?.id : pendingLink}`;
    if (handledNavigation.current === navigationKey) return;
    if (destination === 'bug' && draft) {
      handledNavigation.current = navigationKey;
      if (segmentsRef.current.includes('share-bug')) router.setParams({ draftId: draft.id });
      else router.navigate({ pathname: '/share-bug', params: { draftId: draft.id } });
      consumeBugNavigation();
    } else if (destination === 'beta' && pendingLink) {
      handledNavigation.current = navigationKey;
      if (segmentsRef.current.includes('share-beta')) router.setParams({ link: pendingLink });
      else router.navigate({ pathname: '/share-beta', params: { link: pendingLink } });
      void consumeLink(pendingLink).catch((caught: unknown) => {
        reportHandledError(caught, { tags: { source: 'share-target', op: 'consume-link' } });
      });
    }
  }, [
    isAuthenticated,
    consentSettled,
    launchReady,
    destination,
    revision,
    draft,
    pendingLink,
    router,
    consumeLink,
    consumeBugNavigation,
  ]);

  useEffect(() => {
    if (!notice || !isAuthenticated || !consentSettled || !launchReady) return;
    // A report modal owns inline receipt errors; root toasts sit behind it.
    if (draft || segmentsRef.current.includes('share-bug')) return;
    const message =
      notice === 'invalidLink'
        ? tSession('mobile.betaVideos.urlInvalid')
        : notice === 'unsupported'
          ? t('feedbackAttachments.unsupported')
          : notice === 'tooLarge'
            ? t('feedbackAttachments.tooLarge')
            : notice === 'overflow'
              ? t('feedbackAttachments.tooMany')
              : t('feedbackAttachments.receiveFailed');
    showToast(message, 'error');
    clearNotice();
  }, [notice, isAuthenticated, consentSettled, launchReady, draft, showToast, t, tSession, clearNotice]);
  return <>{children}</>;
}
